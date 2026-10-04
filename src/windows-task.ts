import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultPrivateDirectory } from './maintenance.js';

export async function writeWindowsTaskDefinition(options: {
  repositoryDirectory: string;
  windowsUser: string;
  privateDirectory?: string;
  distro?: string;
  taskName?: string;
  now?: Date;
}): Promise<{ config_path: string; xml_path: string }> {
  if (!path.isAbsolute(options.repositoryDirectory)) {
    throw new Error('Windows task repository path must be absolute');
  }
  const privateDirectory = options.privateDirectory ?? defaultPrivateDirectory();
  const distro = options.distro ?? 'Ubuntu-22.04';
  const taskName = options.taskName ?? 'Isorropia Engine Qualitative Refresh';
  const directory = path.join(privateDirectory, 'windows-task');
  const configPath = path.join(directory, 'config.json');
  const xmlPath = path.join(directory, 'task.xml');
  const logPath = path.join(privateDirectory, 'logs', 'scheduler.log');
  await mkdir(path.dirname(logPath), { recursive: true });
  const shellCommand = [
    'set -o pipefail',
    `cd ${shellQuote(options.repositoryDirectory)}`,
    `npm run maintenance -- rotate-log --log ${shellQuote(logPath)}`,
    `npm run maintenance -- scheduled --limit 100 >> ${shellQuote(logPath)} 2>&1`,
  ].join('; ');
  const startBoundary = nextMondayAtNoon(options.now ?? new Date());
  const xml = windowsTaskXml({
    taskName,
    windowsUser: options.windowsUser,
    distro,
    shellCommand,
    startBoundary,
  });
  await writeJson(configPath, {
    task_name: taskName,
    schedule: 'Monday 12:00 local time',
    distro,
    repository: options.repositoryDirectory,
    requires_clean_dedicated_checkout: true,
    registration: 'not-registered',
  });
  await mkdir(path.dirname(xmlPath), { recursive: true });
  await writeFile(xmlPath, xml, 'utf8');
  return { config_path: configPath, xml_path: xmlPath };
}

export async function rotateMaintenanceLog(
  logPath: string,
  maxBytes = 5 * 1024 * 1024,
  keep = 5,
): Promise<boolean> {
  if (!path.isAbsolute(logPath)) throw new Error('Log path must be absolute');
  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (size < maxBytes) return false;
  await rm(`${logPath}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      await rename(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await rename(logPath, `${logPath}.1`);
  return true;
}

function windowsTaskXml(options: {
  taskName: string;
  windowsUser: string;
  distro: string;
  shellCommand: string;
  startBoundary: string;
}): string {
  const argumentsValue = `-d ${options.distro} -- bash -lc ${windowsQuote(options.shellCommand)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlEscape(options.taskName)}</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>${options.startBoundary}</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek><Monday /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(options.windowsUser)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT8H</ExecutionTimeLimit><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>wsl.exe</Command><Arguments>${xmlEscape(argumentsValue)}</Arguments></Exec></Actions>
</Task>
`;
}

function nextMondayAtNoon(now: Date): string {
  const value = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const days = (8 - value.getUTCDay()) % 7 || 7;
  value.setUTCDate(value.getUTCDate() + days);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}T12:00:00`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
