import { Module } from '@nestjs/common';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { HealthController } from './health/health.controller';

@Module({ imports: [DeliveriesModule], controllers: [HealthController] })
export class AppModule {}
