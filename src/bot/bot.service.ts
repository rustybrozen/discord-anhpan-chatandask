import { Injectable, OnModuleInit, OnModuleDestroy, forwardRef, Inject } from '@nestjs/common';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  PermissionsBitField,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  Message,
} from 'discord.js';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai/ai.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private client: Client;
  private processingUsers = new Set<string>();

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => AiService))
    private aiService: AiService,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async onModuleInit() {
    const token = this.configService.get<string>('DISCORD_TOKEN');

    this.client.once(Events.ClientReady, (c) => {
      console.log(`🤖 Bot Online: ${c.user.tag}`);
      void this.registerSlashCommands();
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      void this.handleInteraction(interaction);
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.handleNaturalChat(message);
    });
    await this.client.login(token);
  }

  async onModuleDestroy() {
    await this.client.destroy();
  }

  private async registerSlashCommands() {
    const commands = [
      new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Trò chuyện với bot')
        .addStringOption((option) =>
          option
            .setName('message')
            .setDescription('Nhập tin nhắn của bạn')
            .setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('setinfo')
        .setDescription('[ADMIN] Cập nhật kiến thức cho bot từ server')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder()
        .setName('setuser')
        .setDescription('[ADMIN] Xem tính cách của một người')
        .addUserOption((option) =>
          option
            .setName('target')
            .setDescription('Chọn user cần xem')
            .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
      new SlashCommandBuilder()
        .setName('fsetuser')
        .setDescription('[ADMIN] Ghi đè tính cách cho một người')
        .addUserOption((option) =>
          option
            .setName('target')
            .setDescription('Chọn user cần thiết lập')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('description')
            .setDescription('Nhập tính cách (VD: Mày là nữ, hay dỗi)')
            .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    ].map((command) => command.toJSON());

    try {
      console.log('⏳ Đang đăng ký Slash Commands...');
      await this.client.application?.commands.set(commands);
      console.log('✅ Đăng ký Slash Commands thành công!');
    } catch (error) {
      console.error('❌ Lỗi đăng ký commands:', error);
    }
  }

  private async handleInteraction(interaction: ChatInputCommandInteraction) {
    const commandName = interaction.commandName;
    const userId = interaction.user.id;

    const isAdmin = () => {
      return (
        interaction.memberPermissions?.has(
          PermissionsBitField.Flags.Administrator,
        ) ?? false
      );
    };

    try {
      if (commandName === 'chat') {
        const query = interaction.options.getString('message', true);

        if (query.length > 800) {
          await interaction.reply({
            content: 'Đọc mỏi mắt quá, hỏi ngắn gọn lại xíu đi! ',
            ephemeral: true,
          });
          return;
        }

        if (this.processingUsers.has(userId)) {
          await interaction.reply({
            content:
              'Từ từ, đang gõ câu trước chưa xong, nói nhanh quá lú não!',
            ephemeral: true,
          });
          return;
        }

        this.processingUsers.add(userId);

        await interaction.deferReply();

        try {
          const roleType = isAdmin() ? '[ADMIN SERVER]' : '[USER THƯỜNG]';
          let liveProfile = `Role Context: ${roleType}\nUser ID: ${userId}\nUsername: ${interaction.user.username}`;

          if (interaction.guild && interaction.member) {
            const member = await interaction.guild.members.fetch(userId);
            const roles = member.roles.cache
              .filter((r) => r.name !== '@everyone')
              .map((r) => r.name)
              .join(', ');
            liveProfile += `\nDisplay Name: ${member.displayName}`;
            liveProfile += `\nRoles: ${roles || 'None'}`;
          }

          const response = await this.aiService.chatAI(
            userId,
            liveProfile,
            query,
          );
          if (response.content) {
            await interaction.editReply(response.content);
          }
        } finally {
          this.processingUsers.delete(userId);
        }
      }

      if (commandName === 'setinfo') {
        if (!isAdmin()) {
          await interaction.reply({
            content: '❌ Bạn không có quyền dùng lệnh này.',
            ephemeral: true,
          });
          return;
        }

        if (!interaction.guild) {
          await interaction.reply({
            content: '❌ Command only works in Server!',
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply();
        await interaction.editReply('🕵️ Crawling server info...');
        await this.handleSetInfoDebug(interaction.guild, interaction);
      }

      if (commandName === 'setuser') {
        if (!isAdmin()) return;

        const targetUser = interaction.options.getUser('target', true);
        await interaction.deferReply({ ephemeral: true });

        const currentPersona = await this.aiService.getPersona(targetUser.id);

        if (currentPersona) {
          await interaction.editReply(
            `🎭 **Tính cách hiện tại với ${targetUser.username}:**\n> ${currentPersona}\n\n*(Dùng \`/fsetuser\` để ghi đè)*`,
          );
        } else {
          await interaction.editReply(
            `⚪ Chưa có thiết lập tính cách cho **${targetUser.username}**.\nDùng \`/fsetuser\` để tạo.`,
          );
        }
      }

      if (commandName === 'fsetuser') {
        if (!isAdmin()) return;

        const targetUser = interaction.options.getUser('target', true);
        const description = interaction.options.getString('description', true);

        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply(
          `⚙️ Đang thiết lập nhân cách mới cho ${targetUser.username}...`,
        );

        const result = await this.aiService.analyzeAndSetPersona(
          targetUser.id,
          targetUser.username,
          description,
        );

        await interaction.editReply(`✅ **Đã cập nhật!**\n> ${result}`);
      }
    } catch (error) {
      console.error('Interaction Error:', error);

      const errorMessage = `❌ **[LỖI HỆ THỐNG]:**\n\`\`\`${(error as Error).message}\`\`\``;

      if (interaction.deferred || interaction.replied) {
        if (isAdmin()) await interaction.editReply(errorMessage);
        else await interaction.editReply('Đang lỗi lú não xíu, tí thử lại nha');
      } else {
        if (isAdmin())
          await interaction.reply({ content: errorMessage, ephemeral: true });
        else
          await interaction.reply({
            content: 'Đang lỗi lú não xíu, tí thử lại nha',
            ephemeral: true,
          });
      }
    }
  }

  private async handleNaturalChat(message: Message) {
    if (message.author.bot) return;

    const botId = this.client.user?.id;
    if (!botId) return;

    const isMentioned = message.mentions.has(botId);

    let isReplyToBot = false;
    if (message.reference && message.reference.messageId) {
      try {
        const repliedMessage = await message.channel.messages.fetch(
          message.reference.messageId,
        );
        if (repliedMessage.author.id === botId) {
          isReplyToBot = true;
        }
      } catch {
        //
      }
    }

    if (!isMentioned && !isReplyToBot) return;

    let query = message.content
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .trim();
    if (!query) query = 'Alo có gì không vậy??';

    const userId = message.author.id;

    if (query.length > 400) {
      await message.reply('Đọc mỏi mắt quá, hỏi ngắn gọn lại xíu đi! ');
      return;
    }

    if (this.processingUsers.has(userId)) {
      await message.reply(
        'Từ từ, đang gõ câu trước chưa xong, nói nhanh quá lú não!',
      );
      return;
    }

    this.processingUsers.add(userId);

    let typingInterval: NodeJS.Timeout | undefined;

    try {
      if ('sendTyping' in message.channel) {
        await (message.channel as TextChannel).sendTyping();
        typingInterval = setInterval(() => {
          void (message.channel as TextChannel).sendTyping();
        }, 9000);
      }

      const isAdmin =
        message.member?.permissions.has(
          PermissionsBitField.Flags.Administrator,
        ) ?? false;
      const roleType = isAdmin ? '[ADMIN SERVER]' : '[USER THƯỜNG]';
      let liveProfile = `Role Context: ${roleType}\nUser ID: ${userId}\nUsername: ${message.author.username}`;

      if (message.member) {
        const roles = message.member.roles.cache
          .filter((r) => r.name !== '@everyone')
          .map((r) => r.name)
          .join(', ');
        liveProfile += `\nDisplay Name: ${message.member.displayName}`;
        liveProfile += `\nRoles: ${roles || 'None'}`;
      }

      const response = await this.aiService.chatAI(userId, liveProfile, query);

      if (response.content) {
        await message.reply(response.content);
      }

      if (response.react) {
        try {
          await message.react(response.react);
        } catch (e) {
          console.error(
            'Lỗi thả react (có thể do emoji LLM bịa ra ko tồn tại):',
            e,
          );
        }
      }
    } catch (error) {
      console.error('Natural Chat Error:', error);
      const isAdmin =
        message.member?.permissions.has(
          PermissionsBitField.Flags.Administrator,
        ) ?? false;
      if (isAdmin) {
        await message.reply(
          `❌ **[LỖI HỆ THỐNG]:**\n\`\`\`${(error as Error).message}\`\`\``,
        );
      }
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      this.processingUsers.delete(userId);
    }
  }

  private async handleSetInfoDebug(
    guild: Guild,
    interaction: ChatInputCommandInteraction,
  ) {
    let rawData = `SERVER: ${guild.name} | Desc: ${guild.description || 'N/A'}\n\n`;

    const keywords = [
      'luật',
      'rule',
      'info',
      'thông-báo',
      'guide',
      'hướng-dẫn',
    ];
    const channels = guild.channels.cache.filter(
      (c) =>
        c.type === ChannelType.GuildText &&
        keywords.some((k) => c.name.toLowerCase().includes(k)),
    );

    for (const [, channel] of channels) {
      const textChannel = channel as TextChannel;
      rawData += `--- CHANNEL: ${textChannel.name} ---\n`;
      try {
        const messages = await textChannel.messages.fetch({ limit: 50 });
        const channelContent = messages
          .reverse()
          .map((m) => {
            let text = m.content;
            if (m.embeds.length > 0) {
              m.embeds.forEach((embed) => {
                text += `\n[Title]: ${embed.title || ''}`;
                text += `\n[Desc]: ${embed.description || ''}`;
                if (embed.fields)
                  embed.fields.forEach(
                    (f) => (text += `\n- ${f.name}: ${f.value}`),
                  );
              });
            }
            return text.trim() ? text : null;
          })
          .filter((t) => t !== null)
          .join('\n');
        rawData += channelContent + '\n\n';
      } catch {
        console.log(`Failed to fetch messages for ${textChannel.name}`);
      }
    }

    console.log('📦 Raw Data Length:', rawData.length);
    await interaction.editReply('🧠 Optimizing data with AI...');

    const optimizedText = await this.aiService.cleanAndSummarize(rawData);
    await interaction.followUp('💾 Updating Database...');

    const result = await this.aiService.refreshServerMemory(
      guild.id,
      optimizedText,
    );
    await interaction.followUp(result);
  }

  public async broadcastMessage(channelId: string, content: string) {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return;

      if ('send' in channel) {
        await channel.send(content);
      }
    } catch (error) {
      console.error(
        `❌ Không thể gửi tin nhắn đến channel ${channelId}. Có thể bot chưa được add vào channel hoặc sai ID. Lỗi:`,
        error,
      );
    }
  }
}
