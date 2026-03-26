import fs from 'fs';
import path from 'path';

import sharp from 'sharp';
import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { isValidGroupFolder } from '../group-folder.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack file attachment (files[] on message events)
interface SlackFile {
  id: string;
  name: string;
  title?: string;
  mimetype: string;
  filetype: string;
  url_private_download?: string;
  size?: number;
}

// Max file size to download (20 MB)
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// MIME types the agent can usefully read (images + PDF + plain text)
const SUPPORTED_MIMETYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
]);

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string; threadTs?: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  /**
   * Derive a safe group folder name from a Slack channel name.
   * Replaces any character outside [A-Za-z0-9_-] with '-', collapses
   * consecutive dashes, strips leading/trailing dashes, and truncates to 63 chars.
   * Falls back to the channel ID if the result is still invalid.
   */
  private toFolderName(channelName: string, channelId: string): string {
    const sanitized = channelName
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);
    return isValidGroupFolder(sanitized) ? sanitized : `slack-${channelId}`.slice(0, 63);
  }

  /**
   * Auto-register a Slack channel the bot has been added to or mentioned in.
   * Always creates with isMain=false and requiresTrigger=true (safe defaults).
   * No-op if the channel is already registered.
   */
  private autoRegisterChannel(channelId: string, channelName: string): void {
    const jid = `slack:${channelId}`;
    if (this.opts.registeredGroups()[jid]) return;

    const folder = this.toFolderName(channelName || channelId, channelId);
    const group: RegisteredGroup = {
      name: channelName || channelId,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      isMain: false,
      requiresTrigger: true,
    };

    logger.info({ jid, folder, channelName }, 'Auto-registering Slack channel');
    this.opts.registerGroup(jid, group);
  }

  private setupEventHandlers(): void {
    // Auto-register when the bot is added to a channel
    this.app.event('member_joined_channel', async ({ event }) => {
      // Only act when the joining member is the bot itself
      if (event.user !== this.botUserId) return;

      let channelName = event.channel;
      try {
        const info = await this.app.client.conversations.info({ channel: event.channel });
        channelName = info.channel?.name || event.channel;
      } catch {
        // fall through with channel ID as name
      }

      this.autoRegisterChannel(event.channel, channelName);
    });

    // Auto-register on first @mention in an unregistered channel
    this.app.event('app_mention', async ({ event }) => {
      const jid = `slack:${event.channel}`;
      if (this.opts.registeredGroups()[jid]) return;

      let channelName = event.channel;
      try {
        const info = await this.app.client.conversations.info({ channel: event.channel });
        channelName = info.channel?.name || event.channel;
      } catch {
        // fall through with channel ID as name
      }

      this.autoRegisterChannel(event.channel, channelName);
    });

    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      // Allow regular messages (no subtype), bot replies, and direct file uploads
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;
      const files = (msg as HandledMessageEvent & { files?: SlackFile[] }).files;

      // Skip events with neither text nor file attachments
      if (!msg.text && !files?.length) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Auto-register on first @mention, in the message handler itself so the
      // triggering message is never dropped (app_mention fires concurrently and
      // can lose the race against this handler).
      if (!this.opts.registeredGroups()[jid] && this.botUserId) {
        const mentionPattern = `<@${this.botUserId}>`;
        if ((msg.text || '').includes(mentionPattern)) {
          let channelName = msg.channel;
          try {
            const info = await this.app.client.conversations.info({ channel: msg.channel });
            channelName = info.channel?.name || msg.channel;
          } catch {
            // fall through with channel ID as name
          }
          this.autoRegisterChannel(msg.channel, channelName);
        }
      }

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text || '';
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Download file attachments and append paths so the agent can read them
      if (files?.length && groups[jid]) {
        const attachmentNote = await this.downloadAttachments(
          files,
          groups[jid].folder,
          msg.ts,
        );
        if (attachmentNote) {
          content = content ? `${content}\n\n${attachmentNote}` : attachmentNote;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        thread_ts: (msg as { thread_ts?: string }).thread_ts,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string, opts?: { threadTs?: string }): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = opts?.threadTs;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text, thread_ts: threadTs });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            thread_ts: threadTs,
          });
        }
      }
      logger.info({ jid, length: text.length, threaded: !!threadTs }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  async addReaction(jid: string, messageId: string, emoji: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.reactions.add({ channel: channelId, timestamp: messageId, name: emoji });
    } catch (err) {
      logger.debug({ jid, messageId, emoji, err }, 'Failed to add reaction');
    }
  }

  async removeReaction(jid: string, messageId: string, emoji: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.reactions.remove({ channel: channelId, timestamp: messageId, name: emoji });
    } catch (err) {
      logger.debug({ jid, messageId, emoji, err }, 'Failed to remove reaction');
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  /**
   * Download Slack file attachments into the group's workspace so the agent
   * can read them via the Read tool (supports images and PDFs natively).
   * Returns a text block describing the attached files, or undefined on failure.
   */
  private async downloadAttachments(
    files: SlackFile[],
    groupFolder: string,
    ts: string,
  ): Promise<string | undefined> {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(groupFolder);
    } catch {
      return undefined;
    }

    // Use the message ts (sanitized) as the subdirectory name so paths are stable
    const safeTs = ts.replace(/[^0-9]/g, '_');
    const attachmentsDir = path.join(groupDir, 'attachments', safeTs);
    const containerAttachmentsDir = `/workspace/group/attachments/${safeTs}`;

    const lines: string[] = [];

    for (const file of files) {
      if (!file.url_private_download) continue;
      if (!SUPPORTED_MIMETYPES.has(file.mimetype) && !file.mimetype.startsWith('image/')) {
        logger.debug({ name: file.name, mimetype: file.mimetype }, 'Skipping unsupported Slack file type');
        continue;
      }
      if (file.size && file.size > MAX_ATTACHMENT_BYTES) {
        logger.warn({ name: file.name, size: file.size }, 'Skipping Slack attachment: too large');
        lines.push(`[Attached file too large to download: ${file.name} (${Math.round(file.size / 1024 / 1024)}MB)]`);
        continue;
      }

      const isImage = file.mimetype.startsWith('image/') && file.mimetype !== 'image/svg+xml';
      const baseName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      // Normalize images to JPEG so the Claude API can process them
      // (avoids wide-gamut ICC profile issues with macOS screenshots etc.)
      const safeName = isImage ? baseName.replace(/\.[^.]+$/, '.jpg') : baseName;
      const destPath = path.join(attachmentsDir, safeName);
      const containerPath = `${containerAttachmentsDir}/${safeName}`;

      try {
        fs.mkdirSync(attachmentsDir, { recursive: true });
        const response = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        // Slack returns 200 OK with an HTML login page when the bot token lacks
        // the files:read scope — validate we got actual binary content, not HTML.
        const contentType = response.headers.get('content-type') || '';
        if (contentType.startsWith('text/html')) {
          throw new Error(
            'Slack returned HTML instead of file content (bot token may be missing files:read scope)',
          );
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (isImage) {
          // Convert to JPEG: normalizes image metadata and strips any unusual PNG
          // chunks/profiles that cause "Could not process image" from the Claude API.
          // flatten() handles transparency by compositing on white before JPEG encoding.
          const jpeg = await sharp(buffer)
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg({ quality: 90 })
            .toBuffer();
          fs.writeFileSync(destPath, jpeg);
        } else {
          fs.writeFileSync(destPath, buffer);
        }
        lines.push(`[Attached: ${file.name} → ${containerPath}]`);
        logger.debug({ name: file.name, containerPath }, 'Downloaded Slack attachment');
      } catch (err) {
        logger.warn({ name: file.name, err }, 'Failed to download Slack attachment');
        lines.push(`[Attachment unavailable: ${file.name}]`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          thread_ts: item.threadTs,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
