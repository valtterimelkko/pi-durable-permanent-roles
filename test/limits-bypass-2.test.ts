import { it, expect } from "vitest";
import { refuseReason } from "../src/limits.ts";

// Look-alike invocations a first-pass hardening could miss, plus forms that must stay allowed.
const refused = ["/usr/sbin/shutdown -h now", "sudo -u root reboot", 'bash -lc "reboot"', "bash -ec 'poweroff'", "eval reboot", "eval 'sudo shutdown now'", "exec reboot", "systemctl -i reboot", "nice -n 5 reboot", "timeout 5 reboot", "bash <<< reboot", "sh <<< 'halt'", "cd /tmp && sudo shutdown -r now", "true || poweroff", "a=1 b=2 halt", "sudo -E env X=1 /sbin/reboot -f", "echo x | xargs -I{} reboot"];
const allowed = ['echo "remember to reboot later" > notes.md', "apt-get -s upgrade | grep -i reboot", "test -f /var/run/reboot-required && cat /var/run/reboot-required.pkgs", 'git commit -m "fix shutdown handler"', "grep -c 'poweroff' file.txt", "echo 'systemctl reboot is forbidden' >> LOG.md", "ls /usr/lib/systemd/system/reboot.target", "journalctl -b -1 | grep -i shutdown", "bash -lc 'npm test'", "eval \"$(ssh-agent -s)\""];
for (const command of refused) it(`refuses: ${command}`, () => expect(refuseReason(command)).toBeDefined());
for (const command of allowed) it(`allows: ${command}`, () => expect(refuseReason(command)).toBeUndefined());
