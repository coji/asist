/**
 * The entry point of the brain. Turn execution lives in turn.ts, the shared state in session.ts and
 * the speech route in speech-route.ts. Everything outside, such as ipc, the live engine and job
 * reporting, uses only startTurn, beginTurn, abortTurn and events.
 */
export { events } from './session'
export { abortTurn, beginTurn, startTurn, type TurnInput, type TurnRuntime } from './turn'
