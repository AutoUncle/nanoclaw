import { randomUUID } from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { getRegisteredGroup, storeChatMetadata, storeMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const GITHUB_JID = 'gh:prs';
const GITHUB_FOLDER = 'github-prs';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface TrackedPR {
  owner: string;
  repo: string;
  number: number;
  /** ISO timestamp — only fetch comments newer than this */
  lastChecked: string;
  /** Whether uncle-claw is still assigned */
  active: boolean;
  /** Whether we have sent the initial assignment notification */
  notified: boolean;
}

interface GitHubState {
  trackedPRs: Record<string, TrackedPR>; // key: "owner/repo#number"
}

class GitHubChannel implements Channel {
  name = 'github';

  private connected = false;
  private token: string;
  private username: string;
  private state: GitHubState = { trackedPRs: {} };
  private stateFile: string;
  private opts: ChannelOpts;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(token: string, username: string, opts: ChannelOpts) {
    this.token = token;
    this.username = username;
    this.opts = opts;
    this.stateFile = path.join(DATA_DIR, 'github-prs-state.json');
    this.loadState();
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load GitHub PR state, starting fresh');
      this.state = { trackedPRs: {} };
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      logger.warn({ err }, 'Failed to save GitHub PR state');
    }
  }

  private githubGet(apiPath: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.github.com',
          path: apiPath,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'nanoclaw-github-channel/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                new Error(
                  `GitHub API ${res.statusCode} for ${apiPath}: ${data.slice(0, 200)}`,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Failed to parse GitHub API response: ${err}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.setTimeout(30_000, () =>
        req.destroy(new Error('GitHub API request timed out')),
      );
      req.end();
    });
  }

  private emitMessage(content: string): void {
    const now = new Date().toISOString();
    const msg: NewMessage = {
      id: randomUUID(),
      chat_jid: GITHUB_JID,
      sender: 'github',
      sender_name: 'GitHub',
      content,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
    };
    storeChatMetadata(GITHUB_JID, now, 'GitHub PRs', 'github', false);
    storeMessage(msg);
    this.opts.onMessage(GITHUB_JID, msg);
  }

  private ensureGroupRegistered(): void {
    const existing = getRegisteredGroup(GITHUB_JID);
    if (!existing) {
      this.opts.registerGroup(GITHUB_JID, {
        name: 'GitHub PRs',
        folder: GITHUB_FOLDER,
        trigger: 'github',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      });
    }

    // Ensure group folder exists (CLAUDE.md should already be there)
    fs.mkdirSync(path.join(GROUPS_DIR, GITHUB_FOLDER), { recursive: true });
  }

  private async pollAssignedPRs(): Promise<void> {
    let data: { items?: Array<Record<string, unknown>> };
    try {
      data = (await this.githubGet(
        `/search/issues?q=assignee:${encodeURIComponent(this.username)}+is:pr+is:open&per_page=50`,
      )) as typeof data;
    } catch (err) {
      logger.warn({ err }, 'Failed to poll GitHub assigned PRs');
      return;
    }

    const assignedKeys = new Set<string>();

    for (const item of data.items ?? []) {
      // Extract owner/repo from repository_url
      // e.g. https://api.github.com/repos/owner/repo
      const repoUrl = String(item.repository_url ?? '');
      const match = repoUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
      if (!match) continue;

      const owner = match[1];
      const repo = match[2];
      const number = item.number as number;
      const key = `${owner}/${repo}#${number}`;
      assignedKeys.add(key);

      if (!this.state.trackedPRs[key]) {
        this.state.trackedPRs[key] = {
          owner,
          repo,
          number,
          lastChecked: new Date().toISOString(),
          active: true,
          notified: false,
        };
      }

      const tracked = this.state.trackedPRs[key];

      if (!tracked.notified) {
        tracked.active = true;
        tracked.notified = true;

        const user =
          (item.user as { login?: string } | null)?.login ?? 'unknown';
        const title = String(item.title ?? '');
        const url = String(item.html_url ?? '');

        const content = [
          `NEW PR ASSIGNED: ${title}`,
          `Repository: ${owner}/${repo}`,
          `PR Number: #${number}`,
          `URL: ${url}`,
          `Author: ${user}`,
          ``,
          `Please review this PR:`,
          `1. Get all comments (review line comments and general PR comments)`,
          `2. Triage each comment`,
          `3. Fix valid issues and commit to the PR branch`,
          `4. Reply and resolve each comment thread on GitHub`,
        ].join('\n');

        this.emitMessage(content);
        logger.info({ key }, 'New PR assignment detected');
      }
    }

    // Detect unassignments / merges / closures
    for (const [key, tracked] of Object.entries(this.state.trackedPRs)) {
      if (!tracked.active || assignedKeys.has(key)) continue;

      // PR disappeared from open+assigned list — find out why
      tracked.active = false;
      try {
        const pr = (await this.githubGet(
          `/repos/${tracked.owner}/${tracked.repo}/pulls/${tracked.number}`,
        )) as {
          state?: string;
          merged?: boolean;
          assignees?: Array<{ login?: string }>;
        };

        if (pr.merged) {
          this.emitMessage(
            `PR MERGED: ${tracked.owner}/${tracked.repo}#${tracked.number}\nThis PR has been merged. Stopping monitoring.`,
          );
          logger.info({ key }, 'PR merged, stopping monitoring');
        } else if (pr.state === 'closed') {
          this.emitMessage(
            `PR CLOSED: ${tracked.owner}/${tracked.repo}#${tracked.number}\nThis PR has been closed. Stopping monitoring.`,
          );
          logger.info({ key }, 'PR closed, stopping monitoring');
        } else {
          // Still open but uncle-claw no longer in assignees
          this.emitMessage(
            `PR UNASSIGNED: ${tracked.owner}/${tracked.repo}#${tracked.number}\nuncle-claw has been unassigned. Stopping monitoring.`,
          );
          logger.info({ key }, 'PR unassigned, stopping monitoring');
        }
      } catch (err) {
        // If we can't fetch the PR, treat it as gone
        logger.warn(
          { key, err },
          'Failed to fetch PR state after disappearing from assigned list',
        );
        this.emitMessage(
          `PR NO LONGER ACTIVE: ${tracked.owner}/${tracked.repo}#${tracked.number}\nStopping monitoring.`,
        );
      }
    }

    this.saveState();
  }

  private async pollPRComments(): Promise<void> {
    for (const [key, tracked] of Object.entries(this.state.trackedPRs)) {
      if (!tracked.active) continue;

      const { owner, repo, number } = tracked;
      const since = tracked.lastChecked;
      const newLastChecked = new Date().toISOString();

      try {
        const [issueComments, reviewComments, reviews] = await Promise.all([
          this.githubGet(
            `/repos/${owner}/${repo}/issues/${number}/comments?since=${encodeURIComponent(since)}&per_page=50`,
          ) as Promise<Array<{ user?: { login?: string }; body?: string }>>,
          this.githubGet(
            `/repos/${owner}/${repo}/pulls/${number}/comments?since=${encodeURIComponent(since)}&per_page=50`,
          ) as Promise<Array<{ user?: { login?: string }; body?: string }>>,
          this.githubGet(
            `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=50`,
          ) as Promise<
            Array<{
              user?: { login?: string };
              state?: string;
              body?: string;
              submitted_at?: string;
            }>
          >,
        ]);

        const newReviews = reviews.filter(
          (r) => r.submitted_at && r.submitted_at > since,
        );

        // Filter out uncle-claw's own comments
        const externalIssueComments = issueComments.filter(
          (c) => c.user?.login !== this.username,
        );
        const externalReviewComments = reviewComments.filter(
          (c) => c.user?.login !== this.username,
        );
        const externalReviews = newReviews.filter(
          (r) => r.user?.login !== this.username,
        );

        const hasNewActivity =
          externalIssueComments.length > 0 ||
          externalReviewComments.length > 0 ||
          externalReviews.length > 0;

        if (hasNewActivity) {
          const parts = [
            `NEW ACTIVITY ON PR: ${owner}/${repo}#${number}`,
            `URL: https://github.com/${owner}/${repo}/pull/${number}`,
            ``,
          ];

          if (externalReviews.length > 0) {
            parts.push(`New reviews (${externalReviews.length}):`);
            for (const r of externalReviews) {
              const snippet = (r.body ?? '').slice(0, 80);
              parts.push(
                `  - ${r.user?.login ?? '?'}: ${r.state ?? '?'}${snippet ? ` — ${snippet}` : ''}`,
              );
            }
            parts.push('');
          }

          if (externalIssueComments.length > 0) {
            parts.push(`New general comments: ${externalIssueComments.length}`);
          }
          if (externalReviewComments.length > 0) {
            parts.push(
              `New line-specific comments: ${externalReviewComments.length}`,
            );
          }

          parts.push('', 'Please review and address the new comments.');
          this.emitMessage(parts.join('\n'));

          logger.info(
            {
              key,
              issueComments: externalIssueComments.length,
              reviewComments: externalReviewComments.length,
              reviews: externalReviews.length,
            },
            'New PR activity detected',
          );
        }

        tracked.lastChecked = newLastChecked;
      } catch (err) {
        logger.warn({ key, err }, 'Failed to poll PR comments');
      }
    }

    this.saveState();
  }

  async connect(): Promise<void> {
    this.ensureGroupRegistered();
    this.connected = true;

    // Initial poll to detect any already-assigned PRs
    await this.pollAssignedPRs();

    this.pollTimer = setInterval(async () => {
      await this.pollAssignedPRs();
      await this.pollPRComments();
    }, POLL_INTERVAL_MS);

    logger.info({ username: this.username }, 'GitHub channel connected');
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    // The container agent uses gh CLI directly for all GitHub interactions.
    // Log the agent's response for observability.
    logger.info(
      { preview: text.slice(0, 120) },
      'GitHub PR agent response (agent handles GitHub replies directly)',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === GITHUB_JID;
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
  }
}

registerChannel('github', (opts: ChannelOpts): Channel | null => {
  const env = readEnvFile(['GITHUB_TOKEN', 'GITHUB_USERNAME']);
  const token = env.GITHUB_TOKEN;
  const username = env.GITHUB_USERNAME || 'uncle-claw';

  if (!token) {
    logger.debug('GITHUB_TOKEN not set, skipping GitHub channel');
    return null;
  }

  return new GitHubChannel(token, username, opts);
});
