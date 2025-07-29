import { decodeTransact } from "./decodeTransaction";

export function tOutPut(data: any){
    const dataTx = data.transaction.transaction
    const signature = decodeTransact(dataTx.signature);
    const message = dataTx.transaction?.message
    const header = message.header;
    const accountKeys = message.accountKeys.map((t: any)=>{
        return  decodeTransact(t)
    })
    const recentBlockhash =  decodeTransact(message.recentBlockhash);
    const instructions = message.instructions
    const meta = dataTx?.meta
    return {
        signature,
        message:{
           header,
           accountKeys,
           recentBlockhash,
           instructions
        },
        meta
    }

}