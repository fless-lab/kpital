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

// The channels an account-event notification may actually use for one recipient:
// the globally-enabled channels intersected with that follower's own preference.
// Iterating configChannels (not the pref) both ignores any junk value a pref may
// hold (the column is free text[]) and yields a Channel[] with no cast. Callers
// pass the follower's pref channels, defaulting to ["email"] ONLY when the
// follower has no pref row at all (an explicit empty array means "opted out of
// everything" and must stay empty). This does NOT apply to transactional auth
// sends (OTP/reset/login) which always fire regardless of preferences.
export function resolveEffectiveChannels(followerChannels: string[], configChannels: Channel[]): Channel[] {
  return configChannels.filter((c) => followerChannels.includes(c));
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
