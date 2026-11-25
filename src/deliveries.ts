import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsObject, IsUrl } from 'class-validator';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Database } from './database';
import { ApiKeyGuard } from './security';

export class CreateDelivery {
  @ApiProperty({ example: 'http://127.0.0.1:4399/webhook' })
  @IsUrl({
    require_tld: false,
    protocols: ['http', 'https'],
    require_protocol: true,
  })
  url!: string;
  @ApiProperty({ example: { event: 'order.confirmed', orderId: 'order-123' } })
  @IsObject()
  payload!: Record<string, unknown>;
}
type Delivery = {
  id: string;
  url: string;
  body: string;
  state: string;
  attempts: number;
  next_at: number;
  lease_until: number | null;
  lease_token: string | null;
  key: string;
  fingerprint: string;
  generation: number;
};
const MAX_ATTEMPTS = 5;

@Injectable()
export class Deliveries implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly db: Database) {
    db.connection.exec(`
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,url TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','processing','delivered','dead')),attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,lease_until INTEGER,lease_token TEXT,key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state,next_at,lease_until);
      CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES deliveries(id),generation INTEGER NOT NULL,number INTEGER NOT NULL,token TEXT NOT NULL UNIQUE,at INTEGER NOT NULL,status TEXT NOT NULL,http_status INTEGER,error TEXT);
    `);
  }
  onModuleInit() {
    if (process.env.WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => {
      if (this.pending.size) return;
      const work = this.dispatch().catch(() =>
        console.error('Falha no worker; eventos persistidos serão retomados'),
      );
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.pending);
  }
  private destination(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('URL inválida');
    }
    const allowed = (process.env.ALLOWED_WEBHOOK_ORIGINS ?? '')
      .split(',')
      .map((x) => x.trim());
    if (
      !allowed.includes(url.origin) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new BadRequestException(
        'Destino fora da lista ALLOWED_WEBHOOK_ORIGINS',
      );
    if (
      url.protocol !== 'https:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
      throw new BadRequestException('Destino externo deve usar HTTPS');
    return url.toString();
  }
  enqueue(input: CreateDelivery, key: string | undefined) {
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key inválida: use 8 a 100 caracteres',
      );
    const url = this.destination(input.url),
      body = JSON.stringify(input.payload);
    const fingerprint = createHash('sha256')
      .update(url + '\n' + body)
      .digest('hex');
    return this.db.transaction(() => {
      const previous = this.db.connection
        .prepare('SELECT * FROM deliveries WHERE key=?')
        .get(key) as Delivery | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ConflictException('Chave já associada a outro evento');
        return this.view(previous.id);
      }
      const id = randomUUID();
      this.db.connection
        .prepare(
          "INSERT INTO deliveries(id,url,body,state,next_at,key,fingerprint) VALUES(?,?,?,'pending',?,?,?)",
        )
        .run(id, url, body, Date.now(), key, fingerprint);
      return this.view(id);
    });
  }
  view(id: string) {
    const row = this.db.connection
      .prepare(
        'SELECT id,url,state,attempts,next_at,generation FROM deliveries WHERE id=?',
      )
      .get(id);
    if (!row) throw new NotFoundException('Entrega inexistente');
    return {
      ...row,
      history: this.db.connection
        .prepare(
          'SELECT generation,number,at,status,http_status,error FROM attempts WHERE delivery_id=? ORDER BY id',
        )
        .all(id),
    };
  }
  retry(id: string) {
    return this.db.transaction(() => {
      this.view(id);
      const result = this.db.connection
        .prepare(
          "UPDATE deliveries SET state='pending',attempts=0,generation=generation+1,next_at=?,lease_until=NULL,lease_token=NULL WHERE id=? AND state='dead'",
        )
        .run(Date.now(), id);
      if (!result.changes)
        throw new ConflictException(
          'Somente entregas dead podem ser reprocessadas',
        );
      return this.view(id);
    });
  }
  private claim(): Delivery | undefined {
    return this.db.transaction(() => {
      const now = Date.now();
      this.db.connection
        .prepare(
          "UPDATE deliveries SET state='dead',lease_token=NULL,lease_until=NULL WHERE state='processing' AND lease_until<=? AND attempts>=?",
        )
        .run(now, MAX_ATTEMPTS);
      const row = this.db.connection
        .prepare(
          "SELECT * FROM deliveries WHERE attempts < ? AND ((state='pending' AND next_at<=?) OR (state='processing' AND lease_until<=?)) ORDER BY next_at,id LIMIT 1",
        )
        .get(MAX_ATTEMPTS, now, now) as Delivery | undefined;
      if (!row) return;
      const token = randomUUID();
      this.db.connection
        .prepare(
          "UPDATE deliveries SET state='processing',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?",
        )
        .run(token, now + 30000, row.id);
      this.db.connection
        .prepare(
          "INSERT INTO attempts(delivery_id,generation,number,token,at,status) VALUES(?,?,?,?,?,'started')",
        )
        .run(row.id, row.generation, row.attempts + 1, token, now);
      return { ...row, attempts: row.attempts + 1, lease_token: token };
    });
  }
  async dispatch() {
    let claimed = 0;
    for (let i = 0; i < 10; i++) {
      const job = this.claim();
      if (!job) break;
      claimed++;
      await this.send(job);
    }
    return { claimed };
  }
  private async send(job: Delivery) {
    let code: number | null = null,
      error: string | null = null,
      retryable = true,
      success = false;
    try {
      this.destination(job.url);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', process.env.WEBHOOK_SECRET!)
        .update(`${timestamp}.${job.id}.${job.body}`)
        .digest('hex');
      const response = await fetch(job.url, {
        method: 'POST',
        body: job.body,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': job.id,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': `v1=${signature}`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      code = response.status;
      success = response.ok;
      retryable = code === 429 || code >= 500;
      await response.body?.cancel();
      if (!success) error = `HTTP ${code}`;
    } catch (cause) {
      error =
        cause instanceof BadRequestException
          ? 'Destino removido da lista de permissão'
          : 'Falha de rede ou timeout';
      if (cause instanceof BadRequestException) retryable = false;
    }
    const state = success
      ? 'delivered'
      : retryable && job.attempts < MAX_ATTEMPTS
        ? 'pending'
        : 'dead';
    const delay = Math.min(60000, 1000 * 2 ** (job.attempts - 1));
    this.db.transaction(() => {
      const result = this.db.connection
        .prepare(
          'UPDATE deliveries SET state=?,next_at=?,lease_until=NULL,lease_token=NULL WHERE id=? AND lease_token=?',
        )
        .run(state, Date.now() + delay, job.id, job.lease_token);
      if (!result.changes) return;
      this.db.connection
        .prepare(
          'UPDATE attempts SET status=?,http_status=?,error=? WHERE token=?',
        )
        .run(success ? 'delivered' : 'failed', code, error, job.lease_token);
    });
  }
}

@ApiTags('Entregas')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: Deliveries) {}
  @Post() @ApiHeader({ name: 'Idempotency-Key', required: true }) create(
    @Body() input: CreateDelivery,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.deliveries.enqueue(input, key);
  }
  @Post('dispatch') dispatch() {
    return this.deliveries.dispatch();
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.deliveries.view(id);
  }
  @Post(':id/retry') retry(@Param('id') id: string) {
    return this.deliveries.retry(id);
  }
}
