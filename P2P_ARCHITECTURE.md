# P2P Party/Room Architecture Documentation

## Overview

Bocchi implements a peer-to-peer (P2P) party/room system that allows users to share skins and synchronize champion selections in real-time. The system is built on **PeerJS** (a WebRTC wrapper) and supports both direct peer-to-peer connections and relay connections through STUN/TURN servers.

---

## Architecture Components

### 1. **Core Services**

#### `p2pService.ts` - Main P2P Service
- **Location**: `src/renderer/src/services/p2pService.ts`
- **Purpose**: Manages room creation, joining, member management, and message broadcasting
- **Key Features**:
  - Room ID generation (6-character alphanumeric codes)
  - Host-based room architecture (one host, multiple members)
  - Automatic retry logic with up to 3 attempts
  - Connection type detection (direct vs relay)
  - NAT type detection
  - Connection quality monitoring

#### `p2pFileTransferService.ts` - File Transfer Service
- **Location**: `src/renderer/src/services/p2pFileTransferService.ts`
- **Purpose**: Handles peer-to-peer file transfers for skin mods
- **Key Features**:
  - Chunked file transfer (64KB chunks)
  - Support for files up to 500MB
  - Progress tracking and resumption
  - File integrity verification (hash checking)
  - 5-minute transfer timeout

#### `iceServerManager.ts` - ICE Server Manager
- **Location**: `src/renderer/src/services/iceServerManager.ts`
- **Purpose**: Manages STUN/TURN server configurations
- **Key Features**:
  - Free STUN/TURN server fallback strategies
  - Connection optimization
  - NAT traversal support

---

## How It Works

### Room Creation Flow

```typescript
// User clicks "Create Room"
1. User enters display name → generateRandomPlayerName() if empty
2. p2pService.createRoom(displayName) is called
3. Generate 6-character room ID (e.g., "A3X9K2")
4. Initialize PeerJS with:
   - Peer ID = room ID
   - ICE servers from iceServerManager
   - Debug logging enabled
5. Create P2PRoom object:
   {
     id: roomId,
     createdAt: Date,
     host: {
       id: roomId,
       name: displayName,
       activeSkins: [],
       isHost: true,
       connected: true
     },
     members: []
   }
6. Set up connection handler for incoming peers
7. Emit 'room-updated' event
8. Return room ID to user
```

### Room Joining Flow

```typescript
// User enters room ID and clicks "Join Room"
1. User enters room ID (e.g., "A3X9K2") and display name
2. p2pService.joinRoom(roomId, displayName) is called
3. Generate unique peer ID: `${roomId}_${timestamp}_${random}`
4. Initialize PeerJS with unique peer ID
5. Connect to host using room ID:
   - metadata: { displayName, type: 'join' }
   - reliable: true
6. Send initial handshake with member info
7. Host receives connection and adds member to room
8. Host broadcasts updated room to all members
9. Member receives room-info message with full room state
10. Emit 'room-updated' event locally
```

### Key Architecture Decisions

#### **Host-Based Architecture**
- One peer acts as the **host** (uses room ID as peer ID)
- All other peers connect to the host
- Host manages room state and broadcasts updates
- If host leaves, room is destroyed

**Pros**:
- Simpler state management
- Single source of truth
- Easier to implement

**Cons**:
- Single point of failure
- Host disconnection kills entire room
- Potential bandwidth bottleneck for host

#### **Alternative: Mesh Architecture** (Not Implemented)
- Every peer connects to every other peer
- No single host
- More resilient to disconnections
- Higher bandwidth requirements (N×(N-1)/2 connections)

---

## Data Types

```typescript
interface P2PRoom {
  id: string                    // 6-character room ID
  createdAt: Date               // Room creation timestamp
  host: P2PRoomMember           // Host information
  members: P2PRoomMember[]      // Array of joined members
}

interface P2PRoomMember {
  id: string                    // Unique peer ID
  name: string                  // Display name
  activeSkins: Array<{          // Currently selected skins
    championKey: string
    championName: string
    championId?: number
    skinId: string
    skinName: string
    skinNum: number
    chromaId?: string
    variantId?: string
  }>
  isHost: boolean               // Host flag
  connected: boolean            // Connection status
  selectedChampion?: {          // Currently selected champion
    id: number
    key: string
    name: string
    isLocked: boolean
  }
}

interface P2PSettings {
  enabled: boolean
  displayName: string
  autoSync: boolean             // Auto-sync skins from party members
}
```

---

## Message Protocol

### Message Types

1. **member-info** - Initial handshake from new member
   ```typescript
   {
     type: 'member-info',
     data: {
       id: peerId,
       name: displayName,
       activeSkins: [],
       isHost: false,
       connected: true
     }
   }
   ```

2. **room-info** - Full room state from host to new member
   ```typescript
   {
     type: 'room-info',
     data: P2PRoom
   }
   ```

3. **room-update** - Broadcast room state update
   ```typescript
   {
     type: 'room-update',
     data: P2PRoom
   }
   ```

4. **active-skins** - Broadcast active skin selections
   ```typescript
   {
     type: 'active-skins',
     data: {
       skins: SelectedSkin[],
       downloadedSkins: Array<{
         championName: string,
         skinName: string,
         localPath?: string
       }>
     }
   }
   ```

5. **champion-selection** - Broadcast champion selection
   ```typescript
   {
     type: 'champion-selection',
     data: {
       id: number,
       key: string,
       name: string,
       isLocked: boolean
     }
   }
   ```

6. **file-offer** - Offer to send a skin file
   ```typescript
   {
     type: 'file-offer',
     id: transferId,
     metadata: {
       fileName: string,
       fileSize: number,
       fileHash: string,
       mimeType: string,
       modInfo: {
         championName: string,
         skinName: string
       }
     },
     skinInfo: SelectedSkin
   }
   ```

7. **file-accept/file-reject** - Response to file offer
8. **file-chunk** - File data chunk
9. **file-complete** - Transfer completion
10. **file-error** - Transfer error

---

## UI Components

### `RoomPanel.tsx`
- **Location**: `src/renderer/src/components/RoomPanel.tsx`
- **Purpose**: Main UI for creating/joining/leaving rooms
- **Features**:
  - Display name input with random name generation
  - Create room button
  - Join room with room ID input (6 characters)
  - Display room ID and member count
  - Copy room ID to clipboard
  - Leave room button
  - P2P connection status indicator

### `P2PConnectionStatus.tsx`
- **Location**: `src/renderer/src/components/P2PConnectionStatus.tsx`
- **Purpose**: Visual indicator of connection status and quality
- **States**: `disconnected`, `connecting`, `connected`

### `SelectedSkinsDrawerWithP2P.tsx`
- **Location**: `src/renderer/src/components/SelectedSkinsDrawerWithP2P.tsx`
- **Purpose**: Drawer showing selected skins with P2P member skins
- **Features**:
  - Display own selected skins
  - Display party members' selected skins
  - Auto-sync functionality
  - File transfer requests

### `FileTransferDialog.tsx`
- **Location**: `src/renderer/src/components/FileTransferDialog.tsx`
- **Purpose**: Dialog for managing file transfer requests
- **Features**:
  - Accept/reject incoming file transfers
  - Progress tracking
  - Transfer speed monitoring

---

## State Management

### Jotai Atoms (Global State)

```typescript
// Room state
export const p2pRoomAtom = atom<P2PRoom | null>(null)

// P2P settings (persisted to localStorage)
export const p2pSettingsAtom = atomWithStorage<P2PSettings>('p2p-settings', {
  enabled: true,
  displayName: 'Player',
  autoSync: false
})

// Connection status
export const p2pConnectionStatusAtom = atom<'disconnected' | 'connecting' | 'connected'>(
  'disconnected'
)

// Auto-synced skins from party members
export const autoSyncedSkinsAtom = atom<Map<string, AutoSyncedSkin[]>>(new Map())
```

---

## Connection & Network Details

### Connection Types

1. **Direct Connection (P2P)**
   - Peers connect directly without intermediary
   - Lower latency
   - Better performance
   - Requires compatible NAT types

2. **Relay Connection (TURN)**
   - Traffic routed through TURN server
   - Works with restrictive NATs/firewalls
   - Higher latency
   - Bandwidth limited by TURN server

### NAT Traversal

The system uses ICE (Interactive Connectivity Establishment) to establish connections:

1. **STUN** servers - Help discover public IP addresses
2. **TURN** servers - Relay traffic when direct connection fails
3. Automatic fallback from direct → relay

### Connection Quality Monitoring

The `p2pService` includes methods to monitor connection quality:

```typescript
// Detect connection type
async detectConnectionType(conn: DataConnection): Promise<'direct' | 'relay'>

// Get connection quality metrics
async getConnectionQuality(peerId?: string): Promise<{
  rtt: number           // Round-trip time (latency)
  type: string          // Connection type
  available: boolean
}>

// Detect NAT type
async detectNATType(): Promise<string>
```

---

## Security Considerations

### Current Implementation

1. **No Authentication**
   - Room IDs are the only "secret"
   - Anyone with room ID can join
   - No password protection

2. **No Encryption (Beyond WebRTC)**
   - WebRTC provides DTLS encryption by default
   - Data in transit is encrypted
   - No additional application-level encryption

3. **Trust Model**
   - Trusts all room members
   - No file scanning/validation
   - File integrity via hash checking only

### Potential Improvements

1. **Room Passwords**
   - Add optional password for rooms
   - Hash-based authentication

2. **Member Approval**
   - Host approves join requests
   - Kick/ban functionality

3. **File Validation**
   - Scan files before accepting
   - Whitelist/blacklist extensions
   - Size limits (already implemented: 500MB)

4. **Rate Limiting**
   - Prevent spam/abuse
   - Connection attempt limits

---

## Known Limitations

1. **Host Dependency**
   - Room dies when host leaves
   - No host migration

2. **NAT/Firewall Issues**
   - Some network configurations may prevent connections
   - Symmetric NAT can be problematic
   - Corporate/school networks may block WebRTC

3. **Scalability**
   - Host bandwidth limits member count
   - Each member = 1 connection to host
   - Practical limit: ~10-20 members

4. **Browser Dependency**
   - Uses browser WebRTC APIs
   - Electron wrapper required
   - No native implementation

5. **File Transfer Limits**
   - 500MB max file size
   - 5-minute timeout
   - No resume after connection loss

---

## Troubleshooting

### Common Issues

1. **Cannot Create/Join Room**
   - Check internet connection
   - Verify PeerJS server is reachable
   - Check firewall/antivirus settings
   - Try different network (mobile hotspot)

2. **Connection Drops Frequently**
   - Unstable internet connection
   - NAT timeout (try TURN server)
   - Check connection quality

3. **File Transfers Fail**
   - File too large (>500MB)
   - Slow connection
   - Firewall blocking data channels
   - Try smaller chunks or different network

4. **Members Can't See Each Other**
   - Room state sync issue
   - Reconnect to room
   - Host should verify member list

---

## Future Enhancements

### Short Term
1. **Host Migration** - Transfer host role when host leaves
2. **Room Passwords** - Optional password protection
3. **Member Kick** - Host can remove members
4. **Better Error Handling** - More descriptive error messages

### Medium Term
1. **Voice Chat** - Integrate WebRTC audio
2. **Chat Messages** - Text chat within room
3. **Room Persistence** - Save/restore room state
4. **Member Profiles** - Avatars, status, etc.

### Long Term
1. **Mesh Architecture** - Remove single point of failure
2. **Dedicated Signaling Server** - Custom PeerJS server
3. **Mobile Support** - iOS/Android apps
4. **Cross-Platform File Transfer** - Support other platforms

---

## Code References

### Key Files
- `src/renderer/src/services/p2pService.ts` - Core P2P logic
- `src/renderer/src/services/p2pFileTransferService.ts` - File transfers
- `src/renderer/src/services/iceServerManager.ts` - ICE server config
- `src/renderer/src/contexts/P2PContext.tsx` - React context provider
- `src/renderer/src/components/RoomPanel.tsx` - Main UI component
- `src/renderer/src/store/atoms.ts` - Global state definitions
- `src/main/types/index.ts` - TypeScript type definitions

### Dependencies
- `peerjs` - WebRTC wrapper library
- `jotai` - State management
- `react-i18next` - Internationalization

---

## Summary

The P2P party/room system provides a decentralized way for users to share skins and synchronize gameplay. Built on WebRTC via PeerJS, it supports both direct peer connections and TURN relay fallback. The host-based architecture simplifies state management but creates a single point of failure. File transfers are chunked and include progress tracking. The system is extensible but has room for improvements in security, scalability, and resilience.
