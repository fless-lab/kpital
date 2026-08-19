import type { NotificationMessage, Provider, Recipient } from "./index";

/**
 * SMS provider stub. For the Foundation it logs to the console; a real SMS
 * gateway can be wired in later without changing the Provider contract.
 */
export const SmsProvider: Provider = {
  channel: "sms",
  async send(to: Recipient, m: NotificationMessage): Promise<void> {
    if (!to.phone) return;
    console.log(`[sms] to=${to.phone} subject=${m.subject} body=${m.body}`);
  },
};
