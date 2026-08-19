import type { NotificationMessage, Provider, Recipient } from "./index";

/**
 * Email provider. For the Foundation it logs to the console; a real SMTP
 * transport can be wired in later without changing the Provider contract.
 */
export const EmailProvider: Provider = {
  channel: "email",
  async send(to: Recipient, m: NotificationMessage): Promise<void> {
    if (!to.email) return;
    console.log(`[email] to=${to.email} subject=${m.subject} body=${m.body}`);
  },
};
