import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const VideoChat = () => {
  const [roomId, setRoomId] = useState("");
  const [userId] = useState(`user_${Date.now()}`);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [peers, setPeers] = useState({});
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef();
  const localVideoRef = useRef();
  const remoteVideosRef = useRef({});
  const pendingPeersRef = useRef(new Set());

  // const SOCKET_SERVER_URL = "http://localhost:5000";

  const SOCKET_SERVER_URL = "https://avah-tetrasyllabic-bernardo.ngrok-free.dev";

  // ✅ userLeftHandler - MISSING BEFORE!
  const userLeftHandler = useCallback((userId) => {
    console.log("👋 User left:", userId);
    
    // Close peer connection
    setPeers(prev => {
      const peerConnection = prev[userId];
      if (peerConnection) {
        peerConnection.close();
        console.log("🔌 Closed peer connection for:", userId);
      }
      const newPeers = { ...prev };
      delete newPeers[userId];
      return newPeers;
    });

    // Remove remote stream
    setRemoteStreams(prev => {
      const newStreams = { ...prev };
      delete newStreams[userId];
      console.log("🗑️ Removed stream for:", userId);
      return newStreams;
    });

    // Cleanup pending peers
    pendingPeersRef.current.delete(userId);
  }, []);

  const createPeerConnection = useCallback((targetUserId) => {
    if (pendingPeersRef.current.has(targetUserId)) {
      console.log("⏭️ Peer creation blocked - already pending:", targetUserId);
      return null;
    }

    const configuration = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    };

    const peerConnection = new RTCPeerConnection(configuration);
    pendingPeersRef.current.add(targetUserId);
    console.log("🔗 Created peer for:", targetUserId);

    peerConnection.oniceconnectionstatechange = () => {
      console.log(`🧊 ICE ${targetUserId}:`, peerConnection.iceConnectionState);
    };

    if (localStream) {
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
    }

    peerConnection.ontrack = (event) => {
      console.log("🎥 ✅ ontrack FIRED for", targetUserId);
      const remoteStream = event.streams[0];
      setRemoteStreams(prev => ({ ...prev, [targetUserId]: remoteStream }));
      pendingPeersRef.current.delete(targetUserId);
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit("ice-candidate", {
          to: targetUserId,
          candidate: event.candidate
        });
      }
    };

    setPeers(prev => ({ ...prev, [targetUserId]: peerConnection }));
    return peerConnection;
  }, [localStream]);

  const createOffer = async (peerConnection, targetUserId) => {
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socketRef.current.emit("offer", {
        to: targetUserId,
        offer: peerConnection.localDescription
      });
    } catch (err) {
      console.error("❌ Offer error:", err);
    }
  };

  const ensurePeerConnection = useCallback((targetUserId, initiateCall = false) => {
    setPeers(prev => {
      if (prev[targetUserId]) {
        console.log("⏭️ Peer exists:", targetUserId);
        return prev;
      }

      if (pendingPeersRef.current.has(targetUserId)) {
        console.log("⏭️ Peer pending:", targetUserId);
        return prev;
      }

      console.log("✅ Creating SINGLE peer for:", targetUserId);
      const peerConnection = createPeerConnection(targetUserId);
      
      if (peerConnection && initiateCall) {
        createOffer(peerConnection, targetUserId);
      }
      
      return { ...prev, [targetUserId]: peerConnection };
    });
  }, [createPeerConnection]);

  const existingUsersHandler = useCallback((users) => {
    console.log("Existing users:", users);
    users.forEach(userId => ensurePeerConnection(userId, true));
  }, [ensurePeerConnection]);

  const joinedUserHandler = useCallback((userId) => {
    console.log("User joined:", userId);
    ensurePeerConnection(userId, true);
  }, [ensurePeerConnection]);

  const offerHandler = useCallback(async ({ from, offer }) => {
    console.log("Offer from:", from);
    ensurePeerConnection(from, false);
    
    setTimeout(() => {
      setPeers(prev => {
        const peerConnection = prev[from];
        if (peerConnection && !peerConnection.remoteDescription) {
          peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
            .then(() => peerConnection.createAnswer())
            .then(answer => peerConnection.setLocalDescription(answer))
            .then(() => {
              socketRef.current.emit("answer", {
                to: from,
                answer: peerConnection.localDescription
              });
            })
            .catch(err => console.error("Offer processing error:", err));
        }
        return prev;
      });
    }, 100);
  }, [ensurePeerConnection]);

  const answerHandler = useCallback(({ from, answer }) => {
    console.log("Answer from:", from);
    setPeers(prev => {
      const peerConnection = prev[from];
      if (peerConnection && peerConnection.signalingState === 'have-local-offer') {
        peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
          .then(() => console.log("✅ Answer accepted"))
          .catch(err => console.error("Answer error:", err));
      } else {
        console.log("⏭️ Answer ignored - wrong state:", peerConnection?.signalingState);
      }
      return prev;
    });
  }, []);

  const iceCandidateHandler = useCallback(({ from, candidate }) => {
    setPeers(prev => {
      const peerConnection = prev[from];
      if (peerConnection) {
        peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
          .catch(err => console.error("ICE error:", err));
      }
      return prev;
    });
  }, []);

  // ✅ COMPLETE SOCKET SETUP WITH userLeftHandler
  useEffect(() => {
    const socket = io(SOCKET_SERVER_URL, {
      transports: ["websocket"],
      reconnectionAttempts:5,
        extraHeaders: {
      "ngrok-skip-browser-warning": "true"  // 🔥 THIS LINE
    }
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("✅ Connected");
      setIsConnected(true);
    });

    socket.on("disconnect", () => setIsConnected(false));

    // ✅ ALL HANDLERS REGISTERED
    socket.on("existing-users", existingUsersHandler);
    socket.on("user-joined", joinedUserHandler);
    socket.on("user-left", userLeftHandler);  // ✅ NOW INCLUDED!
    socket.on("offer", offerHandler);
    socket.on("answer", answerHandler);
    socket.on("ice-candidate", iceCandidateHandler);

    return () => socket.disconnect();
  }, [existingUsersHandler, joinedUserHandler, userLeftHandler, offerHandler, answerHandler, iceCandidateHandler]);

  const startLocalStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      setLocalStream(stream);
    } catch (err) {
      console.error("Camera error:", err);
    }
  };

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const joinRoom = () => {
    if (roomId && localStream) {
      socketRef.current.emit("join-room", { roomId, userId });
    }
  };

  const leaveRoom = () => {
    socketRef.current.emit("leave-room");
    setRoomId("");
    setRemoteStreams({});
    setPeers(prev => {
      Object.values(prev).forEach(pc => pc.close());
      pendingPeersRef.current.clear();
      return {};
    });
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
  };

  useEffect(() => {
    Object.entries(remoteStreams).forEach(([userId, stream]) => {
      const videoElement = remoteVideosRef.current[userId];
      if (videoElement && stream) {
        videoElement.srcObject = stream;
      }
    });
  }, [remoteStreams]);

  return (
   <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900 p-6">
  <div className="max-w-7xl mx-auto">
    {/* Header */}
    <div className="text-center mb-12">
      <h1 className="text-5xl md:text-6xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent mb-4">
        🎥 WebRTC Video Chat
      </h1>
      <p className="text-xl text-indigo-200 max-w-2xl mx-auto">
        Real-time video calling with peer-to-peer WebRTC
      </p>
    </div>

    {/* Controls Card */}
    <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-8 mb-12 shadow-2xl">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-end mb-8">
        {/* Room ID */}
        <div className="md:col-span-2">
          <label className="block text-sm font-semibold text-indigo-200 mb-3">
            Enter Room ID
          </label>
          <div className="relative">
            <input 
              type="text"
              placeholder="e.g., testroom, meeting-123"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="w-full px-5 py-4 bg-white/20 border border-white/30 rounded-2xl text-white placeholder-indigo-300 
                         focus:outline-none focus:ring-4 focus:ring-indigo-500/50 focus:border-transparent
                         backdrop-blur-sm transition-all duration-300 text-lg"
            />
            <div className="absolute right-4 top-1/2 -translate-y-1/2 text-indigo-400">
              📍
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div className="space-y-3">
          <button 
            onClick={startLocalStream} 
            disabled={localStream}
            className="w-full py-4 px-6 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 
                       text-white font-semibold rounded-2xl shadow-xl hover:shadow-2xl transform hover:-translate-y-1 
                       transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
                       focus:outline-none focus:ring-4 focus:ring-emerald-500/50"
          >
            {localStream ? 'Camera ON' : 'Start Camera'}
          </button>
          
          <button 
            onClick={joinRoom} 
            disabled={!roomId || !localStream || !isConnected}
            className="w-full py-4 px-6 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700
                       text-white font-semibold rounded-2xl shadow-xl hover:shadow-2xl transform hover:-translate-y-1 
                       transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
                       focus:outline-none focus:ring-4 focus:ring-indigo-500/50"
          >
            Join Room
          </button>
        </div>

        <button 
          onClick={leaveRoom}
          className="py-4 px-6 bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700
                     text-white font-semibold rounded-2xl shadow-xl hover:shadow-2xl transform hover:-translate-y-1 
                     transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-rose-500/50"
        >
          Leave Room
        </button>
      </div>

      {/* Status Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-white/5 backdrop-blur-sm p-6 rounded-2xl border border-white/10">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-2 rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-500 flex items-center justify-center">
            📶
          </div>
          <div className="text-indigo-200 font-semibold text-lg">{isConnected ? "✅ Connected" : "❌ Disconnected"}</div>
          <div className="text-indigo-400 text-sm">Socket Status</div>
        </div>
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 flex items-center justify-center">
            👤
          </div>
          <div className="text-white font-mono font-semibold text-lg bg-black/30 px-3 py-1 rounded-xl truncate max-w-[200px] mx-auto">
            {userId.slice(-8)}
          </div>
          <div className="text-indigo-400 text-sm">Your ID</div>
        </div>
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-2 rounded-2xl bg-gradient-to-r from-blue-500 to-cyan-500 flex items-center justify-center">
            👥
          </div>
          <div className="text-2xl font-bold text-white">{Object.keys(remoteStreams).length}</div>
          <div className="text-indigo-400 text-sm">Active Peers</div>
        </div>
      </div>
    </div>

    {/* Videos Grid */}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
      {/* Local Video */}
      {localStream && (
        <div className="group">
          <div className="bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border-2 border-blue-500/50 backdrop-blur-xl 
                         rounded-3xl p-8 shadow-2xl hover:shadow-3xl transition-all duration-500 group-hover:scale-[1.02]">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
                📹 You
              </h3>
              <div className="w-10 h-10 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-sm">
                🔴
              </div>
            </div>
            <video 
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className="w-full max-w-md mx-auto rounded-2xl shadow-2xl object-cover"
            />
          </div>
        </div>
      )}

      {/* Remote Videos */}
      <div className="space-y-6">
        {Object.entries(remoteStreams).length === 0 ? (
          <div className="bg-gradient-to-br from-purple-500/20 to-pink-500/20 border-2 border-purple-500/50 
                         backdrop-blur-xl rounded-3xl p-16 text-center shadow-2xl hover:shadow-3xl">
            <div className="w-24 h-24 mx-auto mb-6 rounded-3xl bg-white/20 flex items-center justify-center backdrop-blur-sm">
              👥
            </div>
            <h3 className="text-3xl font-bold text-white mb-4">No Active Calls</h3>
            <p className="text-xl text-indigo-200 max-w-md mx-auto">
              Invite someone to join your room!
            </p>
          </div>
        ) : (
          Object.entries(remoteStreams).map(([userId, stream]) => (
            <div key={userId} className="group">
              <div className="bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border-2 border-emerald-500/50 
                             backdrop-blur-xl rounded-3xl p-6 shadow-2xl hover:shadow-3xl transition-all duration-500 
                             group-hover:scale-[1.02]">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-xl font-bold bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">
                    👤 {userId.slice(-6)}
                  </h4>
                  <div className="w-8 h-8 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-sm">
                    🔴
                  </div>
                </div>
                <video 
                  ref={(el) => {
                    if (el) remoteVideosRef.current[userId] = el;
                  }}
                  autoPlay
                  playsInline
                  className="w-full rounded-2xl shadow-2xl object-cover aspect-video"
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  </div>
</div>

  );
};

export default VideoChat;
