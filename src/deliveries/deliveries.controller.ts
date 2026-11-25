import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../security/api-key.guard';
import { CreateDelivery } from './deliveries.dto';
import { Deliveries } from './deliveries.service';

@ApiTags('Entregas')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: Deliveries) {}

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  create(
    @Body()
    input: CreateDelivery,
    @Headers('idempotency-key')
    key: string | undefined,
  ) {
    return this.deliveries.enqueue(input, key);
  }

  @Post('dispatch')
  dispatch() {
    return this.deliveries.dispatch();
  }

  @Get(':id')
  get(
    @Param('id')
    id: string,
  ) {
    return this.deliveries.view(id);
  }

  @Post(':id/retry')
  retry(
    @Param('id')
    id: string,
  ) {
    return this.deliveries.retry(id);
  }
}
