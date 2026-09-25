import "dotenv/config";
export declare const PROJECT_ROOT: string;
export declare const GATEWAY_DIR: string;
export declare const SESSIONS_DIR: string;
export declare const AUTH_DIR: string;
export declare const ALLOWLIST: Set<string>;
export declare const TELEGRAM_BOT_TOKEN: string;
export declare const TELEGRAM_ALLOWLIST: Set<string>;
export declare const PI_PROVIDER: string;
export declare const PI_MODEL: string;
export declare const PI_IDLE_TIMEOUT_MS: number;
export declare const MAX_PI_PROCESSES: number;
export declare const HEARTBEAT_INTERVAL_MS: number;
export declare const QUIET_HOURS_START: number;
export declare const QUIET_HOURS_END: number;
export declare const CRON_EVAL_INTERVAL_MS: number;
/** Stable hash of a JID for filesystem-safe directory names */
export declare function jidHash(jid: string): string;
export declare function isAllowed(id: string): boolean;
//# sourceMappingURL=config.d.ts.map