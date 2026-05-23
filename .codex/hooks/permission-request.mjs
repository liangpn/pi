import { commandText, denyPermission, isDangerousCommand, readInput } from "./lib.mjs";

const input = await readInput();
const command = commandText(input);

if (isDangerousCommand(command)) {
  denyPermission("阻止潜在破坏性提权请求。请先向用户说明具体影响并获得明确确认。");
}
