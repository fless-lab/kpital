import type { NotificationMessage, Provider, Recipient } from "./index";

/**
 * SMS provider stub. For the Foundation it logs to the console; a real SMS
 * gateway can be wired in later without changing the Provider contract.
 */
export const SmsProvider: Provider = {
  channel: "sms",
  async send(to: Recipient, m: NotificationMessage): Promise<void> {
    if (!to.phone) return;
    // Log only non-secret metadata. The body carries OTP codes and reset links,
    // so it must never be written to logs.
    console.log(`[sms] sent '${m.subject}' to ${to.phone}`);
  },
};
