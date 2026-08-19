import { describe, it, expect } from "vitest";
import { makeNotifier, type Provider } from "./index";

function capture() {
  const sent: { to: unknown; m: unknown }[] = [];
  const p: Provider = {
    channel: "email",
    send: async (to, m) => {
      sent.push({ to, m });
    },
  };
  return { p, sent };
}

describe("notifier", () => {
  it("only invokes providers for active channels", async () => {
    const email = capture();
    const sms = capture();
    (sms.p as { channel: string }).channel = "sms";
    const n = makeNotifier(["email"], [email.p, sms.p]);
    await n.send({ email: "a@b.co", phone: "+228" }, { subject: "s", body: "b" });
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
  });

  it("fans out when both channels are active", async () => {
    const email = capture();
    const sms = capture();
    (sms.p as { channel: string }).channel = "sms";
    const n = makeNotifier(["email", "sms"], [email.p, sms.p]);
    await n.send({ email: "a@b.co", phone: "+228" }, { subject: "s", body: "b" });
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
  });
});
