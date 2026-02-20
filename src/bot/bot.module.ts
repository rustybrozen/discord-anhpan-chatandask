import { forwardRef, Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { AiModule } from '../ai/ai.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule, forwardRef(() => AiModule)],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
