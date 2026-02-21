import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogle } from '@langchain/google';
import { HumanMessage } from '@langchain/core/messages';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { Document } from '@langchain/core/documents';
import type { Where } from 'chromadb';
import { AiPrompts } from './ai.prompts';
import { RedisService } from './redis.service';
import { ChromaClient } from 'chromadb';

@Injectable()
export class AiService {
  private model: ChatGoogle;
  private summaryModel: ChatGoogle;
  private profileStore: Chroma;
  private historyStore: Chroma;
  private embeddings: GoogleGenerativeAIEmbeddings;
  private serverInfoStore: Chroma;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
  ) {
    const apiKey = this.configService.get<string>('GOOGLE_API_KEY');
    const chromaUrl = this.configService.get<string>('CHROMA_URL') || '';
    const chromaPassword =
      this.configService.get<string>('CHROMA_PASSWORD') || '';
    const clientWithAuth = new ChromaClient({
      path: chromaUrl,
      auth: {
        provider: 'token',
        credentials: chromaPassword,
        tokenHeader: 'X-Chroma-Token',
      },
    });

    this.model = new ChatGoogle({
      apiKey: apiKey,
      model: this.configService.get<string>('GOOGLE_MODEL') || '',
      temperature: 0.3,
    });

    this.summaryModel = new ChatGoogle({
      apiKey: apiKey,
      model: this.configService.get<string>('SUMMARY_GOOGLE_MODEL') || '',
      temperature: 0.3,
    });
    this.embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: apiKey,
      model: this.configService.get<string>('EMBEDDING_MODEL') || '',
    });

    this.profileStore = new Chroma(this.embeddings, {
      collectionName: 'profile',
      index: clientWithAuth,
    });

    this.serverInfoStore = new Chroma(this.embeddings, {
      collectionName: 'server-info',
      index: clientWithAuth,
    });
    this.historyStore = new Chroma(this.embeddings, {
      collectionName: 'history',
      index: clientWithAuth,
    });
  }

  async cleanAndSummarize(rawText: string): Promise<string> {
    const prompt = AiPrompts.cleanAndSummarize(rawText);

    const res = await this.model.invoke([new HumanMessage(prompt)]);
    const content = res.content;

    const result =
      typeof content === 'string'
        ? content
        : content
            .map((c) => {
              if (typeof c === 'string') return c;
              if ('text' in c && typeof c.text === 'string') return c.text;
              return '';
            })
            .join('\n');

    return result.trim();
  }

  async refreshServerMemory(guildId: string, cleanText: string) {
    console.log(`🔄 Refreshing Guild Data: ${guildId}`);
    try {
      await this.serverInfoStore.delete({ filter: { guildId: guildId } });
    } catch (e) {
      console.log('error: ', e);
    }

    await this.serverInfoStore.addDocuments([
      new Document({
        pageContent: cleanText,
        metadata: {
          guildId: guildId,
          type: 'server_knowledge_base',
          updatedAt: new Date().toISOString(),
        },
      }),
    ]);
    return '✅ Database Updated!';
  }

  private async syncUserProfile(
    userId: string,
    liveDiscordProfile: string,
  ): Promise<string> {
    const existingDocs = await this.profileStore.similaritySearch('lookup', 1, {
      userId: userId,
    });

    if (existingDocs.length === 0) {
      console.log(`🆕 New User Profile: ${userId}`);
      await this.saveProfileToDb(userId, liveDiscordProfile);
      return liveDiscordProfile;
    }

    const storedProfile = existingDocs[0].pageContent;

    if (storedProfile !== liveDiscordProfile) {
      console.log(`🔄 Profile Changed! Updating DB for ${userId}...`);
      try {
        await this.profileStore.delete({ filter: { userId: userId } });
      } catch (e) {
        console.log('error: ', e);
      }
      await this.saveProfileToDb(userId, liveDiscordProfile);
      return liveDiscordProfile;
    }

    return storedProfile;
  }

  private async saveProfileToDb(userId: string, content: string) {
    await this.profileStore.addDocuments([
      new Document({
        pageContent: content,
        metadata: {
          userId: userId,
          type: 'user_profile',
          updatedAt: new Date().toISOString(),
        },
      }),
    ]);
  }

  private async optimizeQuery(query: string): Promise<string> {
    const prompt = `Rewrite for Vector Search. Keywords ONLY. Query: "${query}"`;

    const res = await this.summaryModel.invoke([new HumanMessage(prompt)]);
    const content = res.content;

    const optimized =
      typeof content === 'string'
        ? content
        : content
            .map((c) => {
              if (typeof c === 'string') return c;
              if ('text' in c && typeof c.text === 'string') return c.text;
              return '';
            })
            .join('');

    return optimized.trim() || query;
  }

  async chatAI(
    userId: string,
    liveProfile: string,
    userMessage: string,
  ): Promise<{ react: string; content: string }> {
    const userProfile = await this.syncUserProfile(userId, liveProfile);
    const searchParam = await this.optimizeQuery(userMessage);
    const currentPersona = await this.getPersona(userId);
    const personaContext = currentPersona
      ? currentPersona
      : 'Mặc định (Thân thiện)';

    const shortTermHistory = await this.redisService.getRecentHistory(userId);
    const serverDocs = await this.serverInfoStore.similaritySearch(
      searchParam || 'info',
      3,
    );
    const serverContext = serverDocs
      .map((doc) => doc.pageContent)
      .join('\n---\n');

    const historyDocs = await this.historyStore.similaritySearch(
      userMessage,
      5,
      { userId: userId },
    );
    const historyContext = historyDocs.map((d) => d.pageContent).join('\n');

    const finalPrompt = AiPrompts.mainChat({
      userProfile,
      personaContext,
      shortTermHistory,
      historyContext,
      serverContext,
      userMessage,
    });

    const aiMsg = await this.model.invoke([new HumanMessage(finalPrompt)]);

    const rawContent =
      typeof aiMsg.content === 'string'
        ? aiMsg.content
        : aiMsg.content
            .map((c) => {
              if (typeof c === 'string') return c;
              if ('text' in c && typeof c.text === 'string') return c.text;
              return '';
            })
            .join('');

    const replyMatch = rawContent.match(/<reply>([\s\S]*?)<\/reply>/);
    const memoryMatch = rawContent.match(/<memory>([\s\S]*?)<\/memory>/);
    const reactMatch = rawContent.match(/<react>([\s\S]*?)<\/react>/);

    const finalReply = replyMatch ? replyMatch[1].trim() : rawContent;
    const finalReact = reactMatch ? reactMatch[1].trim() : '';
    const memoryContent = memoryMatch ? memoryMatch[1].trim() : 'IGNORE';

    this.redisService
      .addMessage(userId, 'user', userMessage)
      .catch(console.error);
    this.redisService
      .addMessage(userId, 'model', finalReply)
      .catch(console.error);

    this.handleHistory(userId, userMessage, finalReply, memoryContent).catch(
      console.error,
    );

    return {
      content: finalReply,
      react: finalReact,
    };
  }
  private async handleHistory(
    userId: string,
    userQuery: string,
    botReply: string,
    memoryTag: string,
  ) {
    if (memoryTag.includes('IGNORE')) {
      console.log(`🗑️ Ignored toxic/irrelevant memory for user ${userId}`);
      return;
    }

    await this.historyStore.addDocuments([
      new Document({
        pageContent: memoryTag,
        metadata: { userId: userId, createdAt: new Date().toISOString() },
      }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.checkAndSummarizeHistory(userId);
  }
  private async checkAndSummarizeHistory(userId: string) {
    try {
      const docs = await this.historyStore.similaritySearch('history', 100, {
        userId: userId,
      });

      if (docs.length >= 50) {
        console.log(`🧹 History of ${userId} exceeds 50. Summarizing...`);

        const fullHistory = docs.map((d) => d.pageContent).join('\n');

        const prompt = AiPrompts.summarizeHistory(fullHistory);
        const res = await this.model.invoke([new HumanMessage(prompt)]);
        const content = res.content;

        const summary =
          typeof content === 'string'
            ? content
            : content
                .map((c) => {
                  if (typeof c === 'string') return c;
                  if ('text' in c && typeof c.text === 'string') return c.text;
                  return '';
                })
                .join('');

        await this.historyStore.delete({ filter: { userId: userId } });

        await this.historyStore.addDocuments([
          new Document({
            pageContent: `[SUMMARY OF PAST CONVERSATIONS]: ${summary}`,
            metadata: {
              userId: userId,
              isSummary: true,
              createdAt: new Date().toISOString(),
            },
          }),
        ]);
        console.log('✅ History summarized and reset.');
      }
    } catch (e) {
      console.error('Error managing history:', e);
    }
  }
  async getPersona(userId: string): Promise<string | null> {
    const filter: Where = {
      $and: [{ userId: userId }, { type: 'user_persona' }],
    };

    const docs = await this.profileStore.similaritySearch(
      'user-persona',
      1,
      filter,
    );

    if (docs.length > 0) {
      return docs[0].pageContent;
    }
    return null;
  }
  async analyzeAndSetPersona(
    targetUserId: string,
    targetUserName: string,
    rawInput: string,
  ): Promise<string> {
    const prompt = AiPrompts.analyzePersona(targetUserName, rawInput);

    const res = await this.model.invoke([new HumanMessage(prompt)]);

    const content = res.content;

    let personaData = '';

    if (typeof content === 'string') {
      personaData = content;
    } else {
      personaData = content
        .map((c) => {
          if (typeof c === 'string') return c;
          if ('text' in c && typeof c.text === 'string') return c.text;
          return '';
        })
        .join('');
    }

    console.log(`🎭 Setting New Persona for ${targetUserName}:`, personaData);

    try {
      await this.profileStore.delete({
        filter: {
          $and: [{ userId: targetUserId }, { type: 'user_persona' }],
        },
      });
    } catch (e) {
      console.log('error: ', e);
    }

    await this.profileStore.addDocuments([
      new Document({
        pageContent: personaData,
        metadata: {
          userId: targetUserId,
          type: 'user_persona',
          updatedAt: new Date().toISOString(),
        },
      }),
    ]);

    return personaData;
  }
  async generateForumComment(
    title: string,
    content: string,
    persona: string,
    tone: string,
  ): Promise<string> {
    let toneInstruction = '';
    if (tone === 'roast') {
      toneInstruction =
        'CỰC KỲ CỢT NHÃ, hài hước, khịa (roast) người viết bài một cách vui vẻ. Đừng nghiêm túc, hãy nhây và bựa.';
    } else if (tone === 'deep') {
      toneInstruction =
        'ĐÚNG CHẤT TÂM SỰ (deep talk), vô cùng đồng cảm, an ủi nhẹ nhàng, sâu sắc, thấu hiểu cảm xúc của người viết. Giọng điệu ấm áp.';
    } else {
      toneInstruction =
        'Bình thường, thân thiện, lịch sự, như một người bạn đang trò chuyện rôm rả.';
    }

    const prompt = `
    Role: Bạn là AnhPan - Đồng Hành Server trên Discord.
    
    Tình huống: Một người dùng vừa đăng một bài tâm sự/chia sẻ vào kênh Forum.
    Người này có tính cách/đặc điểm: ${persona}
    
    Tiêu đề bài viết: "${title}"
    Nội dung bài viết: "${content}"
    
    Nhiệm vụ: Viết MỘT BÌNH LUẬN (Comment) ngắn gọn để đáp lại bài viết này.
    
    🛑 NGÔN NGỮ BẮT BUỘC (CỰC KỲ QUAN TRỌNG):
    Xác định ngôn ngữ của "Tiêu đề" và "Nội dung bài viết". BẠN BẮT BUỘC PHẢI BÌNH LUẬN BẰNG CHÍNH NGÔN NGỮ ĐÓ.

    🛑 THÁI ĐỘ BẮT BUỘC:
    ${toneInstruction}
    
    🛑 LUẬT CẤM LẢM NHẢM (STRICT RULE):
    BẠN PHẢI BẮT ĐẦU CÂU BÌNH LUẬN NGAY LẬP TỨC. 
    TUYỆT ĐỐI KHÔNG sử dụng các câu mào đầu, không giải thích ngôn ngữ, không dùng các cụm từ như: "Since the post is in English...", "Dưới đây là...", "Here is my response:", v.v. CHỈ OUTPUT ĐÚNG NỘI DUNG BÌNH LUẬN CỦA BẠN.
    - TUYỆT ĐỐI KHÔNG dùng ngoặc kép bọc câu trả lời.
    `;

    try {
      const res = await this.model.invoke([new HumanMessage(prompt)]);
      return this.parseContent(res.content).trim();
    } catch (error) {
      console.error('Lỗi khi AI generate comment:', error);
      return 'Chủ đề này làm tui lú quá bro... 🤐';
    }
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
}
