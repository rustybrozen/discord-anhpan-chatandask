import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private redis: Redis;

  constructor(private configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get<string>('REDIS_HOST') || 'localhost',
      port: this.configService.get<number>('REDIS_PORT') || 6379,
      password: this.configService.get<string>('REDIS_PASSWORD') || '',
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  async addMessage(
    userId: string,
    role: 'user' | 'model',
    content: string,
  ): Promise<void> {
    const key = `chat_history:${userId}`;
    const MAX_CHAR_LENGTH = 800;
    let safeContent = content;

    if (safeContent.length > MAX_CHAR_LENGTH) {
      safeContent =
        safeContent.substring(0, MAX_CHAR_LENGTH) + '...(truncated)';
    }

    const msg = JSON.stringify({ role, content: safeContent });
    const pipeline = this.redis.pipeline();

    pipeline.rpush(key, msg);
    pipeline.ltrim(key, -20, -1);
    pipeline.expire(key, 3600);

    await pipeline.exec();
  }

  async getRecentHistory(userId: string): Promise<string> {
    const key = `chat_history:${userId}`;
    const rawData = await this.redis.lrange(key, 0, -1);

    return rawData
      .map((item) => {
        const parsed = JSON.parse(item) as { role: string; content: string };
        return `${parsed.role === 'user' ? 'User' : 'Bot'}: ${parsed.content}`;
      })
      .join('\n');
  }
  async addFactTopic(topic: string): Promise<void> {
    const key = `daily_facts_topics`;
    const pipeline = this.redis.pipeline();
    pipeline.lpush(key, topic);
    pipeline.ltrim(key, 0, 49);
    await pipeline.exec();
  }

  async getFactHistory(): Promise<string> {
    const key = `daily_facts_topics`;
    const rawData = await this.redis.lrange(key, 0, -1);
    return rawData.length > 0 ? rawData.join(', ') : 'Chưa có chủ đề nào';
  }
}
