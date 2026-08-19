import type { Config } from "../../config/env";
import { EmailProvider } from "./email";
import { SmsProvider } from "./sms";

export type Channel = "email" | "sms";
export type Recipient = { email?: string; phone?: string };
export type NotificationMessage = { subject: string; body: string };

export interface Provider {
  channel: Channel;
  send(to: Recipient, m: NotificationMessage): Promise<void>;
}

export interface Notifier {
  send(to: Recipient, m: NotificationMessage): Promise<void>;
}

export function makeNotifier(channels: Channel[], providers: Provider[]): Notifier {
  const active = providers.filter((p) => channels.includes(p.channel));
  return {
    async send(to, m) {
      await Promise.all(active.map((p) => p.send(to, m)));
    },
  };
}

export function makeDefaultNotifier(config: Config): Notifier {
  return makeNotifier(config.notifyChannels, [EmailProvider, SmsProvider]);
}
