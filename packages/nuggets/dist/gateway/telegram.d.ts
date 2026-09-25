import { Bot } from "grammy";
export type TelegramMessageHandler = (chatId: string, text: string) => Promise<void>;
export interface TelegramConnection {
    bot: Bot;
    sendMessage: (chatId: string, text: string) => Promise<void>;
    stop: () => void;
}
export declare function connectTelegram(token: string, onMessage: TelegramMessageHandler): TelegramConnection;
//# sourceMappingURL=telegram.d.ts.map