interface Message{
    chat_id: string,
    parse_mode: string,
    text: string,
    reply_to_message_id: string | (-1)
}
/// A "stored" message
export type R =  {
	groupId: string;
	userName: string;
	content: string;
	messageId: string;
	timeStamp: number;
}
export type Reply = {
    type: "text", text: string
} | {
    type: "query", payload: R[]
}
export type PhotoId = {url: string}
export type Photo = {
    file_id: PhotoId
}
interface CtxCommandData{
    update_type: "message" | "photo" | "command"
    update: {
        message:{
            photo: Photo[];
            from: {
                id: string;
            }
            chat: {
                type: "group"
                id: string;
                title: string;
            }
            text: string;
            message_id: string;
        }
    }
    bot: {
        api: "APIKEY"
    }
}
interface CtxCommandAction{
    reply: (text: string | Reply, parse_mode?: string)=>Promise<{ok: boolean}>;
    getFile(file_id: PhotoId): Promise<Response>;
    api: {
        sendMessage(chatId: string, message: Message): Promise<{ok: boolean}>
    }
}
export type CtxCommand = CtxCommandData & CtxCommandAction
interface Handlers{
    status(ctx: CtxCommand): void;
    query(ctx: CtxCommand): void;
    ask(ctx: CtxCommand): void;
    summary(ctx: CtxCommand): void;
    ":message": (ctx: CtxCommand)=>void;
    ":schedule": (ctx: CtxCommand)=>void;
}

export function getMessageLink(r: R){
    return `https://matrix.example.com/c/${parseInt(r.groupId.slice(2))}/${r.messageId}`
}
export class MockBot{
    responseData: Reply[] = [];
    handlers: Partial<Handlers> = {};
    env: Env;
    constructor(env: Env){
        this.env = env;
    }
    on<T extends keyof Handlers>(event: T, handler: Handlers[T]){
        this.handlers[event] = handler;
        return this;
    }
    castMessage(msg: string | Reply): Reply{
        return typeof msg === "string" ? {type: "text", text: msg} : msg;
    }
    async handle(request: Request){
        const PRESHARED_AUTH_HEADER_KEY = "X-Custom-PSK";
        const PRESHARED_AUTH_HEADER_VALUE = this.env.api_psk;
        const psk = request.headers.get(PRESHARED_AUTH_HEADER_KEY);
        if (psk !== PRESHARED_AUTH_HEADER_VALUE){
            return new Response("Unauthorized", {status: 401});
        }
        const actions : CtxCommandAction = {
            reply: async (text: string | Reply, parse_mode?: string)=>{
                this.responseData.push(this.castMessage(text));
                return {ok: true};
            },
            getFile: async (fileId: PhotoId)=>{
                return fetch(fileId.url);
            },
            api:{
                sendMessage: async (groupId: string, msg: Message)=>{
                    // no private chat.
                    return actions.reply(msg.text, msg.parse_mode);
                }
            }
        }
        if(request.method !== "POST"){
            return new Response("Method Not Allowed", {status: 405});
        }
        if(request.headers.get("Content-Type") !== "application/json"){
            return new Response("Unsupported Media Type", {status: 415});
        }
        const data: {event: keyof Handlers, payload: CtxCommandData} = (await request.json());
        const handler = this.handlers[data.event];
        if(!handler){
            return new Response("Not Found", {status: 404});
        }
        const agent : CtxCommand = {...actions, ...data.payload};
        await handler(agent);
        return Response.json({events: this.responseData});
    }
}