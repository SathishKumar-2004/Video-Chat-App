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
    <div className="video-chat-container">
      <h1>🎥 WebRTC Video Chat</h1>
      <div className='controls'>
        <input 
          type="text"
          placeholder='Enter Room ID (e.g., testroom)'
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          style={{ padding: '10px', fontSize: '16px', width: '200px' }}
        />
        <button 
          onClick={startLocalStream} 
          disabled={localStream}
          style={{ padding: '10px 20px', margin: '0 5px' }}
        >
          {localStream ? '✅ Camera ON' : 'Start Camera'}
        </button>
        <button 
          onClick={joinRoom} 
          disabled={!roomId || !localStream || !isConnected}
          style={{ padding: '10px 20px', margin: '0 5px' }}
        >
          Join Room
        </button>
        <button 
          onClick={leaveRoom}
          style={{ padding: '10px 20px', margin: '0 5px', background: '#ff4444', color: 'white' }}
        >
          Leave Room
        </button>
        <div>📶 Status: <strong>{isConnected ? "✅ Connected" : "❌ Disconnected"}</strong></div>
        <div>👤 User ID: <strong>{userId}</strong></div>
      </div>

      <div className="videos-container" style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '20px' }}>
        {localStream && (
          <div style={{ textAlign: 'center', border: '2px solid #007bff', padding: '10px', borderRadius: '8px' }}>
            <h3>📹 You</h3>
            <video 
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              style={{ width: '300px', height: '200px', objectFit: 'cover', borderRadius: '4px' }}
            />
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px' }}>
          {Object.entries(remoteStreams).map(([userId, stream]) => (
            <div key={userId} style={{ textAlign: 'center', border: '2px solid #28a745', padding: '10px', borderRadius: '8px' }}>
              <h4>👤 Remote: {userId}</h4>
              <video 
                ref={(el) => {
                  if (el) remoteVideosRef.current[userId] = el;
                }}
                autoPlay
                playsInline
                style={{ width: '400px', height: '300px', objectFit: 'cover', borderRadius: '4px' }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default VideoChat;
