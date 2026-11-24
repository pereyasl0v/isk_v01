/**
 * Poll job progress promptly while active, but avoid hammering SQLite in idle
 * and background tabs. All values are in milliseconds.
 */
export function statePollDelay(running,visible=true){
 if(!visible)return 60_000;
 return running?2_000:30_000;
}
export function keepUnchangedState(previous,next){
 if(previous===null||previous===undefined)return next;
 return JSON.stringify(previous)===JSON.stringify(next)?previous:next;
}
