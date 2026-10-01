import type { CommandCenterConfig } from "./service/command-center.js";

export interface AppConfig extends CommandCenterConfig {
  port: number;
  databasePath: string;
  demoMode: boolean;
  slackBotToken?: string;
  slackSigningSecret?: string;
  ingestToken?: string;
  demoSlackChannelId?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const demoMode = env.DEMO_MODE === "true";
  return {
    port: Number(env.PORT ?? "8787"),
    databasePath: env.DATABASE_PATH ?? "data/qira-command-center.sqlite",
    demoMode,
    stripeAccountId: env.QIRA_STRIPE_ACCOUNT_ID ?? "acct_1TrCD18W7UytlyLE",
    slackWorkspaceUrl: env.SLACK_WORKSPACE_URL ?? "https://qira-global.slack.com",
    channels: {
      control: env.SLACK_CONTROL_CHANNEL_ID ?? "demo-control",
      replies: env.SLACK_REPLIES_CHANNEL_ID ?? "demo-replies",
      pipeline: env.SLACK_PIPELINE_CHANNEL_ID ?? "demo-pipeline",
      alerts: env.SLACK_ALERTS_CHANNEL_ID ?? "demo-alerts",
      wins: env.SLACK_WINS_CHANNEL_ID ?? "demo-wins",
    },
    ...(env.SLACK_BOT_TOKEN ? { slackBotToken: env.SLACK_BOT_TOKEN } : {}),
    ...(env.SLACK_SIGNING_SECRET ? { slackSigningSecret: env.SLACK_SIGNING_SECRET } : {}),
    ...(env.QIRA_INGEST_TOKEN ? { ingestToken: env.QIRA_INGEST_TOKEN } : {}),
    ...(env.DEMO_SLACK_CHANNEL_ID ? { demoSlackChannelId: env.DEMO_SLACK_CHANNEL_ID } : {}),
  };
}
