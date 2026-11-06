import { it, expect } from "vitest";
import { refuseReason } from "../src/limits.ts";

// Deeper bypass forms a first reading of the reboot guard could miss.
const refused = ["timeout -s 9 10 reboot", "timeout --signal=KILL 10 reboot", "su -c reboot", "sudo su -c 'shutdown -h now'", "su root -c poweroff", "echo reboot | bash", "printf 'halt\\n' | sudo sh", "echo 'systemctl reboot' | bash -s"];
const allowed = ["timeout 30 npm test", "timeout -s 9 10 npm test", "su -c 'apt list --upgradable'", "echo hello | bash", "echo reboot | grep reboot", "echo 'reboot later' >> notes.md"];
for (const command of refused) it(`refuses: ${command}`, () => expect(refuseReason(command)).toBeDefined());
for (const command of allowed) it(`allows: ${command}`, () => expect(refuseReason(command)).toBeUndefined());
