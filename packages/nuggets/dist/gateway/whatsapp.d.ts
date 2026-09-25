import { type WASocket } from "@whiskeysockets/baileys";
export type MessageHandler = (jid: string, text: string) => Promise<void>;
export interface WhatsAppConnection {
    sock: WASocket;
    /** Resolves when connection is established and QR is scanned */
    ready: Promise<void>;
    /** Send a text message (tracks ID to avoid processing our own echo) */
    sendMessage: (jid: string, text: string) => Promise<unknown>;
}
export declare function connectWhatsApp(onMessage: MessageHandler): Promise<WhatsAppConnection>;
//# sourceMappingURL=whatsapp.d.ts.map