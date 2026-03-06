import * as os from 'os';

const WINDOWS_ENV_KEYS = [
    'ALLUSERSPROFILE',
    'APPDATA',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'COMMONPROGRAMW6432',
    'COMPUTERNAME',
    'COMSPEC',
    'DRIVERDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'PUBLIC',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
];

const POSIX_ENV_KEYS = [
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'SHELL',
    'SHLVL',
    'TMPDIR',
    'USER',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
];

export function buildSanitizedEnv(
    overrides: Record<string, string> = {},
    prependPaths: string[] = [],
): Record<string, string> {
    const isWin = os.platform() === 'win32';
    const allowList = new Set((isWin ? WINDOWS_ENV_KEYS : POSIX_ENV_KEYS).map(key => key.toUpperCase()));
    const env: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
        if (!value) continue;
        if (allowList.has(key.toUpperCase())) {
            env[key] = value;
        }
    }

    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    const pathSep = isWin ? ';' : ':';
    const currentPath = process.env[pathKey] || process.env.PATH || '';
    const mergedPath = [...prependPaths.filter(Boolean), currentPath].filter(Boolean).join(pathSep);
    if (mergedPath) {
        env[pathKey] = mergedPath;
    }

    if (isWin && !env.HOME && env.USERPROFILE) {
        env.HOME = env.USERPROFILE;
    }

    return { ...env, ...overrides };
}
