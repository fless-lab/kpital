import type { NotificationMessage, Provider, Recipient } from "./index";

/**
 * Email provider. For the Foundation it logs to the console; a real SMTP
 * transport can be wired in later without changing the Provider contract.
 */
export const EmailProvider: Provider = {
  channel: "email",
  async send(to: Recipient, m: NotificationMessage): Promise<void> {
    if (!to.email) return;
    // Log only non-secret metadata. The body carries OTP codes and reset links,
    // so it must never be written to logs.
    console.log(`[email] sent '${m.subject}' to ${to.email}`);
  },
};
