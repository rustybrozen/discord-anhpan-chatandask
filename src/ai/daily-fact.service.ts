import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ChatGoogle } from '@langchain/google';
import { HumanMessage } from '@langchain/core/messages';
import { RedisService } from './redis.service';
import { BotService } from 'src/bot/bot.service';
import { AiPrompts } from './ai.prompts';

@Injectable()
export class DailyFactService {
  private readonly logger = new Logger(DailyFactService.name);
  private targetChannels: string[];
  private factModel: ChatGoogle;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    @Inject(forwardRef(() => BotService))
    private botService: BotService,
  ) {
    const channelsString =
      this.configService.get<string>('DAILY_FACT_CHANNELS') || '';
    this.targetChannels = channelsString
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    const apiKey = this.configService.get<string>('GOOGLE_API_KEY');
    this.factModel = new ChatGoogle({
      apiKey: apiKey,
      model: this.configService.get<string>('DAILY_GOOGLE_MODEL') || '',
      temperature: 0.85,
    });
  }

  private parseContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c: unknown) => {
          if (typeof c === 'string') return c;
          if (c !== null && typeof c === 'object' && 'text' in c) {
            return (c as Record<string, unknown>).text as string;
          }
          return '';
        })
        .join('');
    }
    return '';
  }

  async generateUniqueFact(): Promise<{
    topic: string;
    content: string;
  } | null> {
    const pastTopics = await this.redisService.getFactHistory();

    const prompt = AiPrompts.dailyPrompt(pastTopics);

    try {
      const res = await this.factModel.invoke([new HumanMessage(prompt)]);
      const rawText = this.parseContent(res.content);

      const topicMatch = rawText.match(/<topic>([\s\S]*?)<\/topic>/);
      const contentMatch = rawText.match(/<content>([\s\S]*?)<\/content>/);

      if (!topicMatch || !contentMatch) {
        this.logger.error('LLM trả về sai định dạng XML');
        return null;
      }

      return {
        topic: topicMatch[1].trim(),
        content: contentMatch[1].trim(),
      };
    } catch (error) {
      this.logger.error('Lỗi khi gọi LLM tạo Fact:', error);
      return null;
    }
  }

  @Cron('0 8 * * *')
  async handleDailyFact() {
    if (this.targetChannels.length === 0) return;

    this.logger.log('🧠 Đang suy nghĩ Fact mới...');

    const factData = await this.generateUniqueFact();
    if (!factData) return;

    this.logger.log(`✅ Đã tạo xong bài viết chủ đề: ${factData.topic}`);
    await this.redisService.addFactTopic(factData.topic);
    this.logger.log('🚀 Đang rải Fact vào các channel Discord...');

    for (const channelId of this.targetChannels) {
      await this.botService.broadcastMessage(channelId, factData.content);
    }

    this.logger.log('🎉 Đăng Fact thành công!');
  }
}
