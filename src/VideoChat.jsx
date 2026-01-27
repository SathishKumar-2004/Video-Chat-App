import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const VideoChat = () => {
  const [roomId, setRoomId] = useState("");
  const [userId] = useState(`user_${Date.now()}`);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [peers, setPeers] = useState({});
  const [isConnected, setIsConnected] = useState(false);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isInRoom, setIsInRoom] = useState(false);

  const socketRef = useRef();
  const localVideoRef = useRef();
  const remoteVideosRef = useRef({});
  const pendingPeersRef = useRef(new Set());

  // const SOCKET_SERVER_URL = "http://localhost:5000";

   const SOCKET_SERVER_URL = "https://avah-tetrasyllabic-bernardo.ngrok-free.dev";

  const toggleAudio = useCallback(() => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsAudioEnabled(audioTracks[0]?.enabled ?? false);

    }
  }, [localStream]);
  
 // Helper function to create a black video track
const createBlackVideoTrack = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  const stream = canvas.captureStream();
  return stream.getVideoTracks()[0];
};

// ✅ Better Toggle Video (using black frames)
const toggleVideo = useCallback(async () => {
  if (!localStream) return;
  
  const videoTracks = localStream.getVideoTracks();
  
  if (isVideoEnabled) {
    // Turn OFF: Stop real camera and replace with black video
    videoTracks.forEach(track => track.stop());
    
    const blackTrack = createBlackVideoTrack();
    
    // Replace with black track in all peer connections
    Object.values(peers).forEach(peerConnection => {
      const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        sender.replaceTrack(blackTrack);
      }
    });
    
    // Replace in local stream
    videoTracks.forEach(track => localStream.removeTrack(track));
    localStream.addTrack(blackTrack);
    
    setIsVideoEnabled(false);
    
    // Update local video element
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  } else {
    // Turn ON: Replace black track with real camera
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 1280 }, height: { ideal: 720 } } 
      });
      
      const newVideoTrack = newStream.getVideoTracks()[0];
      
      // Remove black track
      const oldTracks = localStream.getVideoTracks();
      oldTracks.forEach(track => {
        track.stop();
        localStream.removeTrack(track);
      });
      
      localStream.addTrack(newVideoTrack);
      
      // Replace in all peer connections
      Object.values(peers).forEach(peerConnection => {
        const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          sender.replaceTrack(newVideoTrack);
        } else {
          peerConnection.addTrack(newVideoTrack, localStream);
        }
      });
      
      // Update local video element
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
      }
      
      setIsVideoEnabled(true);
    } catch (err) {
      console.error("Failed to restart video:", err);
      alert("Could not turn on camera");
    }
  }
}, [localStream, isVideoEnabled, peers]);
  const userLeftHandler = useCallback((userId) => {
    console.log("👋 User left:", userId);

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

    setRemoteStreams(prev => {
      const newStreams = { ...prev };
      delete newStreams[userId];
      console.log("🗑️ Removed stream for:", userId);
      return newStreams;
    });

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

  useEffect(() => {
    const socket = io(SOCKET_SERVER_URL, {
      transports: ["websocket"],
      reconnectionAttempts: 5,
      extraHeaders: {
        "ngrok-skip-browser-warning": "true"
      }
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("✅ Connected");
      setIsConnected(true);
    });

    socket.on("disconnect", () => setIsConnected(false));

    socket.on("existing-users", existingUsersHandler);
    socket.on("user-joined", joinedUserHandler);
    socket.on("user-left", userLeftHandler);
    socket.on("offer", offerHandler);
    socket.on("answer", answerHandler);
    socket.on("ice-candidate", iceCandidateHandler);

    return () => socket.disconnect();
  }, [existingUsersHandler, joinedUserHandler, userLeftHandler, offerHandler, answerHandler, iceCandidateHandler]);
  const startLocalStream = async (withVideo = true, withAudio = true) => {
    try {
      const constraints = {
        video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        audio: withAudio
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setLocalStream(stream);
      setIsVideoEnabled(withVideo);
      setIsAudioEnabled(withAudio);
    } catch (err) {
      console.error("Camera error:", err);
      alert("Failed to access camera/microphone. Please check permissions.");
    }
  };

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);
  const joinRoom = () => {
    if (roomId && isConnected) {
      socketRef.current.emit("join-room", { roomId, userId });
      setIsInRoom(true);
    }
  };

  const leaveRoom = () => {
    socketRef.current.emit("leave-room");
    setRoomId("");
    setIsInRoom(false);
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
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <header className="border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-semibold text-white">VideoConnect</h1>
                <p className="text-xs text-slate-400">Secure Real-Time Communication</p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/50 border border-slate-700">
                <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-sm text-slate-300">{isConnected ? 'Connected' : 'Disconnected'}</span>
              </div>

              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/50 border border-slate-700">
                <svg className="w-4 h-4 text-slate-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                </svg>
                <span className="text-sm font-mono text-slate-300">{userId.slice(-8)}</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {}
        <div className="bg-slate-800/50 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-6 mb-8 shadow-xl">
          <div className="flex flex-col lg:flex-row gap-4 items-end">
            <div className="flex-1 min-w-0">
              <label htmlFor="roomId" className="block text-sm font-medium text-slate-300 mb-2">
                Room ID
              </label>
              <input
                id="roomId"
                type="text"
                placeholder="Enter room ID (e.g., meeting-123)"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                disabled={isInRoom}
                className="w-full px-4 py-3 bg-slate-900/50 border border-slate-600 rounded-xl text-white placeholder-slate-500
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                           transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Room ID input"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              {!localStream ? (
                <>
                  <button
                    onClick={() => startLocalStream(true, true)}
                    className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl
                               shadow-lg hover:shadow-xl transform hover:-translate-y-0.5
                               transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900
                               flex items-center gap-2"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Connect Media
                  </button>

                </>
              ) : null}

              <button
                onClick={joinRoom}
                disabled={!roomId || !isConnected || isInRoom}
                className="px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-xl
                           shadow-lg hover:shadow-xl transform hover:-translate-y-0.5
                           transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed
                           disabled:transform-none focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-slate-900
                           flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                </svg>
                {isInRoom ? 'In Room' : 'Join Room'}
              </button>

              {isInRoom && (
                <button
                  onClick={leaveRoom}
                  className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-medium rounded-xl
                             shadow-lg hover:shadow-xl transform hover:-translate-y-0.5
                             transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-slate-900
                             flex items-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Leave
                </button>
              )}
            </div>
          </div>

          {isInRoom && (
            <div className="mt-4 pt-4 border-t border-slate-700/50 flex items-center justify-between">
              <div className="flex items-center gap-4 text-sm">
                <span className="text-slate-400">Participants:</span>
                <span className="text-white font-semibold">{Object.keys(remoteStreams).length + 1}</span>
              </div>

            </div>
          )}
        </div>

        {}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {}
          {localStream && (
            <div className="relative group">
              <div className="bg-slate-800/50 backdrop-blur-xl border border-slate-700/50 rounded-2xl overflow-hidden shadow-xl">
                <div className="absolute top-4 left-4 z-10 flex items-center gap-2 px-3 py-1.5 bg-slate-900/80 backdrop-blur-sm rounded-lg border border-slate-700">
                  <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-sm font-medium text-white">You</span>
                </div>

                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full aspect-video object-cover bg-slate-900"
                  aria-label="Your video stream"
                />

                {}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-slate-900/95 to-transparent p-4">
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={toggleAudio}
                      className={`p-3 rounded-full transition-all ${
                        isAudioEnabled
                          ? 'bg-slate-800/80 hover:bg-slate-700'
                          : 'bg-red-600 hover:bg-red-700'
                      }`}
                      aria-label={isAudioEnabled ? "Mute microphone" : "Unmute microphone"}
                    >
                      {isAudioEnabled ? (
                        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                        </svg>
                      )}
                    </button>

                    <button
                      onClick={toggleVideo}
                      className={`p-3 rounded-full transition-all ${
                        isVideoEnabled
                          ? 'bg-slate-800/80 hover:bg-slate-700'
                          : 'bg-red-600 hover:bg-red-700'
                      }`}
                      aria-label={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
                    >
                      {isVideoEnabled ? (
                        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 3l18 18" />
    </svg>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {}
          {Object.entries(remoteStreams).length === 0 ? (
            <div className="bg-slate-800/30 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-12 flex flex-col items-center justify-center text-center min-h-[400px]">
              <div className="w-20 h-20 bg-slate-700/50 rounded-2xl flex items-center justify-center mb-4">
                <svg className="w-10 h-10 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-slate-300 mb-2">Waiting for participants</h3>
              <p className="text-slate-500 max-w-sm">
                Share the room ID with others to start your video conference
              </p>
            </div>
          ) : (
            Object.entries(remoteStreams).map(([userId, stream]) => (
              <div key={userId} className="relative group">
                <div className="bg-slate-800/50 backdrop-blur-xl border border-slate-700/50 rounded-2xl overflow-hidden shadow-xl">
                  <div className="absolute top-4 left-4 z-10 flex items-center gap-2 px-3 py-1.5 bg-slate-900/80 backdrop-blur-sm rounded-lg border border-slate-700">
                    <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                    </svg>
                    <span className="text-sm font-medium text-white font-mono">{userId.slice(-6)}</span>
                  </div>

                  <video
                    ref={(el) => {
                      if (el && stream) {
                        remoteVideosRef.current[userId] = el;
                        el.srcObject = stream;
                        {console.log(stream)}
                      }
                    }}
                    autoPlay
                    playsInline
                    className="w-full aspect-video object-cover bg-slate-900"
                    aria-label={`Video stream from participant ${userId.slice(-6)}`}
                  />
                  
                </div>
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
};

export default VideoChat;