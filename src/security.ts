import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const supplied = context.switchToHttp().getRequest().headers['x-api-key'];
    const configured = process.env.API_KEY ?? '';
    if (typeof supplied !== 'string')
      throw new UnauthorizedException('X-Api-Key ausente');
    const left = Buffer.from(supplied),
      right = Buffer.from(configured);
    if (left.length !== right.length || !timingSafeEqual(left, right))
      throw new UnauthorizedException('Credencial inválida');
    return true;
  }
}
