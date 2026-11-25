import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsUrl } from 'class-validator';

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
