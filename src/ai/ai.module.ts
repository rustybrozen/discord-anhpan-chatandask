import { forwardRef, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { RedisService } from './redis.service';
import { DailyFactService } from './daily-fact.service';
import { BotModule } from 'src/bot/bot.module';

@Module({
  controllers: [AiController],
  providers: [AiService, RedisService, DailyFactService],
  exports: [AiService],
  imports: [forwardRef(() => BotModule)],
})
export class AiModule {}
