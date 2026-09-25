/**
 * The host bridge for one node: maps the sandbox API onto the world. Every
 * method is a thin call into `World`; `WorldError`s propagate into the VM as
 * ordinary exceptions the node's own code can catch.
 */
import type { HostBridge } from "../sandbox/api";
import type { World } from "../world/world";

export function makeBridge(world: World, agentId: string, onLog?: (line: string) => void): HostBridge {
  return {
    observe: () => world.observe(agentId),
    move: (dir) => world.intentMove(agentId, dir),
    moveToward: (q, r) => world.intentMoveToward(agentId, q, r),
    gather: () => world.intentGather(agentId),
    eat: (n) => world.intentEat(agentId, n),
    drop: (n) => world.intentDrop(agentId, n),
    rest: () => world.intentRest(agentId),
    say: (text) => world.intentSay(agentId, text),
    send: (to, payloadJson) => world.intentSend(agentId, to, payloadJson),
    fsRead: (path) => world.fsRead(agentId, path),
    fsWrite: (path, content) => world.fsWrite(agentId, path, content),
    fsList: () => world.fsList(agentId),
    fsRemove: (path) => world.fsRemove(agentId, path),
    ruinFiles: (id) => world.ruinFiles(agentId, id),
    ruinRead: (id, path) => world.ruinRead(agentId, id, path),
    setProfile: (key, value) => world.setProfile(agentId, key, value),
    log: (line) => {
      world.addLog(agentId, line);
      onLog?.(line);
    },
  };
}
