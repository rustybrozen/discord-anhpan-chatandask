import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { ConfigModule } from '@nestjs/config';
import { BotModule } from './bot/bot.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    AiModule,
    ConfigModule.forRoot({ isGlobal: true }),
    BotModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
