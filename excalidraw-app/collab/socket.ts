import { getCollabServer } from "../data";
import { loadFirebaseRTDB } from "../data/firebase";
import type firebase from "firebase/app";
import { trackEvent } from "../../src/analytics";

type roomId = string;
type userId = string;
interface EventMap {
  "init-room": [undefined];
  "first-in-room": [undefined];
  "join-room": [roomId];
  "new-user": [userId];
  "room-user-change": [userId[]];
  "server-broadcast": [roomId, ArrayBuffer, Uint8Array];
  "server-volatile-broadcast": [roomId, ArrayBuffer, Uint8Array];
  "client-broadcast": [ArrayBuffer, Uint8Array];
  "connect_error": [undefined];
}

type EventNames = keyof EventMap;

interface FirebaseEventType {
  args: any[];
  from?: userId | null;
  sequence: number;
}

export class FirebaseSocket {
  private roomId: string;
  private callbacks: Partial<Record<EventNames, Function[]>> = {};
  private rtdb: firebase.database.Database;
  public id: string | null = null;

  // Record to store the latest sequence number for each event.
  private latestSequence: Record<string, number> = {};

  constructor(roomId: string, rtdb: firebase.database.Database) {
    this.roomId = roomId;
    this.rtdb = rtdb;
  }

  joinRoom(roomId: string) {
    // TODO: this logic is not working, let's discuss how to deal with user presence

    const connectedRef = this.rtdb.ref('.info/connected');
    connectedRef.on('value', (snap) => {
      if (snap.val() === true) {
        // We're connected (or reconnected)! Do anything here that should happen only if online (or on reconnect)
      }
    });

    // listen for room user changes
    this.rtdb.ref(`${roomId}/users`).on('value', (snapshot) => {
      const value = snapshot.val();
      console.log("room user change", value);
      if (value !== null) {
        const users = Object.keys(value);
        if (users.length === 1) {
          // let myself know I'm the first here
          this.callbacks["first-in-room"]!.forEach((cb) => cb());
        }
        this.emit("room-user-change", users);
      } else {
        this.callbacks["first-in-room"]!.forEach((cb) => cb());
      }
    })

    // add myself to the room
    this.rtdb.ref(`${roomId}/users`).push().then((ref) => {
      this.id = ref.key;
      this.emit("new-user", this.id as string);
      // When I disconnect, remove myself from the list of online users
      ref.onDisconnect().remove();
    });

  }

  on<K extends EventNames>(event: K, callback: (...args: EventMap[K]) => void) {
    if (!this.callbacks[event]) {
      this.callbacks[event] = [];
    }
    this.callbacks[event]!.push(callback as Function);

    this.rtdb.ref(`${this.roomId}/${event}`).on('value', (snapshot) => {
      const value = snapshot.val() as FirebaseEventType;
      if (value !== null) {
        if (this.shouldHandleRtdbEvent(event, value) && Array.isArray(this.callbacks[event])){
          this.callbacks[event]!.forEach((cb) => this.callbackFromRtdbEvent(event, value, cb));
        }
      }
    });
  }

  once<K extends EventNames>(event: K, callback: (...args: EventMap[K]) => void) {
    const onceCallback = (snapshot: firebase.database.DataSnapshot) => {
      const value = snapshot.val() as FirebaseEventType;
      if (value !== null) {
        if (this.shouldHandleRtdbEvent(event, value)){
          this.callbackFromRtdbEvent(event, value, callback);
          this.rtdb.ref(`${this.roomId}/${event}`).off('value', onceCallback);
        }
      }
    };

    this.rtdb.ref(`${this.roomId}/${event}`).on('value', onceCallback);
  }

  toRTDBEvent<K extends EventNames>(args: EventMap[K]): FirebaseEventType {
    return { args, from: this.id, sequence: Date.now() };
  }

  callbackFromRtdbEvent<K extends EventNames>(event:K, rtdbEventData: FirebaseEventType, cb: Function) {
    if (event === "client-broadcast") {
      // transform encryptedData to array buffer and iv to Uint8Array
        rtdbEventData.args[0] = new Uint8Array(rtdbEventData.args[0]);
        rtdbEventData.args[1] = new Uint8Array(rtdbEventData.args[1]);
    }
    console.log("callbackFromRtdbEvent", event, rtdbEventData.args)
    return cb(...rtdbEventData.args);
  }

  shouldHandleRtdbEvent<K extends EventNames>(event:K, rtdbEventData: FirebaseEventType): boolean {
    const { sequence, from } = rtdbEventData;
    if (from === this.id) return false;  // we emitted this event ourselves, ignore it

    // Check if the message should be processed or ignored based on if we handled a newer message already
    if (rtdbEventData.sequence > (this.latestSequence[event] || 0)) {
      this.latestSequence[event] = sequence;
      // this event is newer then the last one we received, handle it
      return true;
    }
    return false;
  }

  mapEventToRtdbEventName<K extends EventNames>(event: K): EventNames {
    switch (event) {
      case "server-broadcast":
        return "client-broadcast";
      case "server-volatile-broadcast":
        return "client-broadcast";
      default:
        return event;
    }
  }

  mapEventToRtdbEventArgs<K extends EventNames>(event: K, args: EventMap[K]) {
    switch (event) {
      // strip out roomId from server-broadcast events and emit them as client-broadcast
      case "server-broadcast":
        return [new Uint8Array(args[1] as ArrayBuffer), args[2]] as [Uint8Array, Uint8Array];
      case "server-volatile-broadcast":
        return [new Uint8Array(args[1] as ArrayBuffer), args[2]] as [Uint8Array, Uint8Array];
      default:
        return args;
    }
  }

  emit<K extends EventNames>(event: K, ...args: EventMap[K]) {
    const rtdbEventName = this.mapEventToRtdbEventName(event);
    const rtdbEventArgs = this.mapEventToRtdbEventArgs(event, args) as EventMap[K];
    console.debug("emit", rtdbEventName, rtdbEventArgs);
    this.rtdb.ref(`${this.roomId}/${rtdbEventName}`).set(this.toRTDBEvent(rtdbEventArgs));
  }

  off(event: EventNames, _cb?: Function) {
    if (this.callbacks[event]) {
      this.callbacks[event] = [];
      this.rtdb.ref(`${this.roomId}/${event}`).off();
    }
  }

  close() {
    this.rtdb.ref(`${this.roomId}/users`).off();
    this.rtdb.ref('.info/connected').off();
    for (const event in this.callbacks) {
      this.off(event as EventNames);
    }
  }
}

export class SocketIOSocket {
  private _socket: SocketIOClient.Socket;
  private roomId: string;

  constructor(socket: SocketIOClient.Socket, roomId: string) {
    this._socket = socket;
    this.roomId = roomId;
  }

  get id() {
    return this._socket.id;
  }

  joinRoom(roomId: string) {
    this.on("init-room", () => {
      if (this._socket) {
        this.emit("join-room", this.roomId as string);
        trackEvent("share", "room joined");
      }
    });
  }

  on<K extends EventNames>(event: K, callback: (...args: EventMap[K]) => void) {
    this._socket.on(event, callback);
  }

  once<K extends EventNames>(event: K, callback: (...args: EventMap[K]) => void) {
    this._socket.once(event, callback);
  }

  emit<K extends EventNames>(event: K, ...args: EventMap[K]) {
    this._socket.emit(event, ...args);
  }

  off(event: string, cb?: Function) {
    this._socket.off(event, cb);
  }

  close() {
    this._socket.close();
  }
}

export type SocketTypes = SocketIOSocket | FirebaseSocket;

async function getSocket(roomId: string): Promise<SocketTypes> {
  if (import.meta.env.VITE_APP_USE_FIREBASE_SOCKET){
    const firebase = await loadFirebaseRTDB();
    return new FirebaseSocket(roomId, firebase.database());
  }
  else {
    const socketServerData = await getCollabServer();
    const { default: socketIOClient } = await import(
      /* webpackChunkName: "socketIoClient" */ "socket.io-client"
      );

    return new SocketIOSocket(socketIOClient(socketServerData.url, {
      transports: socketServerData.polling
        ? ["websocket", "polling"]
        : ["websocket"],
    }), roomId);
  }
}

export default getSocket;
