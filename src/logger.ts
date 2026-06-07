/**
 * A tiny, dependency-free logger styled after Vite's dev output:
 * `HH:MM:SS [giri] (scope) message`. Colors auto-disable for non-TTY output, `NO_COLOR`,
 * or `TERM=dumb`, so piped/CI logs stay clean.
 */

const noColor =
    !process.stdout.isTTY ||
    process.env.NO_COLOR !== undefined ||
    process.env.TERM === 'dumb' ||
    process.env.FORCE_COLOR === '0';

function paint(open: number, close: number): (text: string) => string {
    return (text) => (noColor ? text : `\x1b[${open}m${text}\x1b[${close}m`);
}

export const color = {
    dim: paint(2, 22),
    bold: paint(1, 22),
    red: paint(31, 39),
    green: paint(32, 39),
    yellow: paint(33, 39),
    blue: paint(34, 39),
    magenta: paint(35, 39),
    cyan: paint(36, 39),
    gray: paint(90, 39),
};

/** Green for paths/values, like Vite highlights updated files. */
export const highlight = (text: string): string => color.green(text);
/** Dim for secondary details (counts, durations). */
export const muted = (text: string): string => color.dim(text);

function timestamp(): string {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

const TAG = 'giri';

function line(tag: string, message: string, scope?: string): string {
    const parts = [color.gray(timestamp()), tag];
    if (scope) {
        parts.push(color.dim(`(${scope})`));
    }
    parts.push(message);
    return parts.join(' ');
}

const tag = {
    info: color.bold(color.cyan(`[${TAG}]`)),
    warn: color.bold(color.yellow(`[${TAG}]`)),
    error: color.bold(color.red(`[${TAG}]`)),
};

export const log = {
    info(message: string, scope?: string): void {
        console.log(line(tag.info, message, scope));
    },
    success(message: string, scope?: string): void {
        console.log(line(tag.info, color.green(message), scope));
    },
    warn(message: string, scope?: string): void {
        console.warn(line(tag.warn, color.yellow(message), scope));
    },
    error(message: string, scope?: string): void {
        console.error(line(tag.error, color.red(message), scope));
    },
    ready(url: string): void {
        console.log(line(tag.info, `${color.green('ready')} on ${color.cyan(url)}`));
    },
    change(verb: string, path: string, count?: number): void {
        const suffix = count && count > 1 ? ` ${color.dim(`(x${count})`)}` : '';
        console.log(line(tag.info, `${color.green(verb)} ${highlight(path)}${suffix}`, 'watch'));
    },
};
