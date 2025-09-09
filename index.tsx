import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";

const API_KEY = process.env.API_KEY;

// FIX: Add minimal type definitions for the Web Speech API to resolve compilation errors.
// These types are not always included in the default TS DOM library.
interface SpeechRecognitionAlternative {
    readonly transcript: string;
}
interface SpeechRecognitionResult {
    readonly isFinal: boolean;
    readonly length: number;
    [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
    readonly length: number;
    [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
    readonly error: string;
}

// SpeechRecognition API vendor prefixes
// FIX: Cast window to `any` to access vendor-prefixed properties `SpeechRecognition`
// and `webkitSpeechRecognition` which may not exist on the standard `Window` type.
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
let recognition: any;
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    // Use manual restart for a more reliable "continuous" mode, as browser implementations can be buggy.
    recognition.continuous = false;
    recognition.interimResults = true;
}

type Language = 'ja-JP' | 'zh-TW';
type Mode = 'turn-taking' | 'continuous';

interface LogEntry {
    id: number;
    original: string;
    translated: string | null;
    lang: Language;
}

interface Recording {
    id: number;
    url: string;
    blob: Blob;
    duration: string;
    name: string;
}

const App: React.FC = () => {
    const [isListening, setIsListening] = useState(false);
    const [currentLang, setCurrentLang] = useState<Language>('ja-JP');
    const [mode, setMode] = useState<Mode>('turn-taking');
    const [log, setLog] = useState<LogEntry[]>([]);
    const [interimTranscript, setInterimTranscript] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isTranslating, setIsTranslating] = useState(false);
    const [recordings, setRecordings] = useState<Recording[]>([]);
    
    const ai = useRef<GoogleGenAI | null>(null);
    const logEndRef = useRef<HTMLDivElement>(null);
    const intentionalStop = useRef(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const audioPlayers = useRef<Map<number, HTMLAudioElement>>(new Map());


    useEffect(() => {
        if (!API_KEY) {
            setError("API_KEY environment variable not set.");
            return;
        }
        ai.current = new GoogleGenAI({ apiKey: API_KEY });

        if (!SpeechRecognition) {
            setError("Speech recognition is not supported in this browser.");
        }
        
        return () => {
             // Cleanup object URLs to prevent memory leaks
            recordings.forEach(rec => URL.revokeObjectURL(rec.url));
            // Stop any media tracks when component unmounts
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
            }
        };

    }, []);

    useEffect(() => {
        if (!recognition) return;

        const handleResult = (event: SpeechRecognitionEvent) => {
            let finalTranscript = '';
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interim += event.results[i][0].transcript;
                }
            }
            
            setInterimTranscript(interim);

            if (finalTranscript) {
                handleTranslation(finalTranscript.trim());
            }
        };

        const handleError = (event: SpeechRecognitionErrorEvent) => {
            // Ignore "no-speech" errors as the 'end' event will handle restarting if necessary.
            if (event.error === 'no-speech') {
                return;
            }
            setError(`Speech recognition error: ${event.error}`);
            stopListeningAndRecording();
        };

        const handleEnd = () => {
            if (intentionalStop.current) {
                stopListeningAndRecording();
                return;
            }

            if (isListening && mode === 'continuous') {
                try {
                     recognition.start();
                } catch(e) {
                    console.error("Error restarting recognition", e);
                    stopListeningAndRecording();
                }
            } else {
                stopListeningAndRecording();
            }
        };

        recognition.addEventListener('result', handleResult);
        recognition.addEventListener('error', handleError);
        recognition.addEventListener('end', handleEnd);

        return () => {
            recognition.removeEventListener('result', handleResult);
            recognition.removeEventListener('error', handleError);
            recognition.removeEventListener('end', handleEnd);
        };
    }, [isListening, mode]);
    
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [log, interimTranscript]);

    const handleTranslation = async (text: string) => {
        if (!text || !ai.current) return;
        
        const newEntry: LogEntry = {
            id: Date.now(),
            original: text,
            translated: null,
            lang: currentLang,
        };
        
        setLog(prevLog => [...prevLog, newEntry]);
        setIsTranslating(true);
        setInterimTranscript('');
        
        const sourceLangText = currentLang === 'ja-JP' ? 'Japanese' : 'Traditional Chinese';
        const targetLangText = currentLang === 'ja-JP' ? 'Traditional Chinese' : 'Japanese';

        try {
            const prompt = `Translate the following ${sourceLangText} text to ${targetLangText}. Preserve the context, tone, and any professional terminology. Return only the translated text, without any additional explanations or introductory phrases.\n\nText: "${text}"`;
            
            const response = await ai.current.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            const translatedText = response.text;
            
            setLog(prevLog => prevLog.map(entry =>
                entry.id === newEntry.id ? { ...entry, translated: translatedText } : entry
            ));

            if (mode === 'turn-taking') {
                setCurrentLang(prevLang => prevLang === 'ja-JP' ? 'zh-TW' : 'ja-JP');
            }

        } catch (err) {
            console.error(err);
            setError("Failed to translate text.");
             setLog(prevLog => prevLog.map(entry =>
                entry.id === newEntry.id ? { ...entry, translated: "Translation failed." } : entry
            ));
        } finally {
            setIsTranslating(false);
        }
    };

    const startListeningAndRecording = async () => {
        if (!recognition) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            mediaRecorderRef.current = new MediaRecorder(stream);
            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorderRef.current.onstop = () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
                const audioUrl = URL.createObjectURL(audioBlob);

                const tempAudio = document.createElement('audio');
                tempAudio.src = audioUrl;
                tempAudio.onloadedmetadata = () => {
                     const duration = tempAudio.duration;
                     const minutes = Math.floor(duration / 60);
                     const seconds = Math.floor(duration % 60).toString().padStart(2, '0');
                     const newRecording: Recording = {
                        id: Date.now(),
                        url: audioUrl,
                        blob: audioBlob,
                        duration: `${minutes}:${seconds}`,
                        name: `Recording - ${new Date().toLocaleString()}`,
                     };
                    setRecordings(prev => [...prev, newRecording]);
                };
                
                audioChunksRef.current = [];
                 if (streamRef.current) {
                    streamRef.current.getTracks().forEach(track => track.stop());
                    streamRef.current = null;
                }
            };
            
            mediaRecorderRef.current.start();
            intentionalStop.current = false;
            recognition.lang = currentLang;
            recognition.start();
            setIsListening(true);
            setError(null);

        } catch (e) {
            console.error("Error starting media devices:", e);
            setError(`Could not start microphone: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const stopListeningAndRecording = () => {
        if (recognition) {
            recognition.stop();
        }
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.stop();
        }
        setIsListening(false);
        intentionalStop.current = false;
    };


    const handleListenToggle = () => {
        if (isListening) {
            intentionalStop.current = true;
            stopListeningAndRecording();
        } else {
            startListeningAndRecording();
        }
    };

    const handleDownloadRecording = (recording: Recording) => {
        const link = document.createElement('a');
        link.href = recording.url;
        link.download = `${recording.name.replace(/[:/]/g, '-')}.wav`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleDeleteRecording = (id: number) => {
        const recordingToDelete = recordings.find(r => r.id === id);
        if (recordingToDelete) {
            URL.revokeObjectURL(recordingToDelete.url);
        }
        setRecordings(prev => prev.filter(r => r.id !== id));
    };
    
    const handlePlayPause = (id: number) => {
        const audio = audioPlayers.current.get(id);
        if (audio) {
            if (audio.paused) {
                audio.play();
            } else {
                audio.pause();
            }
        }
    };


    return (
        <div className="app-container">
            <header className="app-header">
                <h1>AI 即時翻譯</h1>
            </header>
            <div className="main-content">
                <main className="conversation-log" aria-live="polite">
                    {log.map((entry) => (
                        <div key={entry.id} className={`message-bubble ${entry.lang === 'ja-JP' ? 'is-ja' : 'is-zh'}`}>
                            <p className="original-text">{entry.original}</p>
                            <p className="translated-text">
                                {entry.translated === null ? '...' : entry.translated}
                            </p>
                        </div>
                    ))}
                    {interimTranscript && <div className="interim-transcript">{interimTranscript}</div>}
                     <div ref={logEndRef} />
                </main>
                {recordings.length > 0 && (
                    <aside className="recordings-panel">
                        <h2>Saved Recordings</h2>
                        <ul className="recordings-list">
                            {recordings.map(rec => (
                                <li key={rec.id} className="recording-item">
                                    <div className="recording-info">
                                        <span className="recording-name">{rec.name}</span>
                                        <span className="recording-duration">{rec.duration}</span>
                                    </div>
                                    <div className="recording-controls">
                                        <audio
                                            // FIX: A ref callback function should not return a value. 
                                            // This was changed to a block body to ensure an implicit `undefined` return,
                                            // satisfying TypeScript's type requirements for refs.
                                            ref={el => {
                                                if (el) {
                                                    audioPlayers.current.set(rec.id, el);
                                                } else {
                                                    audioPlayers.current.delete(rec.id);
                                                }
                                            }}
                                            src={rec.url}
                                            preload="metadata"
                                        />
                                        <button onClick={() => handlePlayPause(rec.id)} aria-label="Play/Pause recording" className="control-btn">
                                            <span className="material-symbols-outlined">play_arrow</span>
                                        </button>
                                        <button onClick={() => handleDownloadRecording(rec)} aria-label="Download recording" className="control-btn">
                                            <span className="material-symbols-outlined">download</span>
                                        </button>
                                        <button onClick={() => handleDeleteRecording(rec.id)} aria-label="Delete recording" className="control-btn delete-btn">
                                            <span className="material-symbols-outlined">delete</span>
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </aside>
                )}
            </div>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <footer className="app-controls">
                <div className="control-group lang-selector">
                    <button
                        onClick={() => setCurrentLang(lang => lang === 'ja-JP' ? 'zh-TW' : 'ja-JP')}
                        className="language-toggle-button"
                        disabled={isListening}
                        aria-label={`Current direction: ${currentLang === 'ja-JP' ? 'Japanese to Chinese' : 'Chinese to Japanese'}. Click to switch.`}
                    >
                        {currentLang === 'ja-JP' ? (
                            <>
                                <span className="lang-jp">日</span>
                                <span className="material-symbols-outlined arrow">arrow_right_alt</span>
                                <span className="lang-zh">中</span>
                            </>
                        ) : (
                            <>
                                <span className="lang-zh">中</span>
                                <span className="material-symbols-outlined arrow">arrow_right_alt</span>
                                <span className="lang-jp">日</span>
                            </>
                        )}
                    </button>
                </div>
                <div className="control-group mic-control">
                    <button 
                        className={`mic-button ${isListening ? 'listening' : ''}`} 
                        onClick={handleListenToggle}
                        disabled={isTranslating}
                        aria-label={isListening ? 'Stop Listening' : 'Start Listening'}
                    >
                        <span className="material-symbols-outlined">
                            {isListening ? 'stop' : 'mic'}
                        </span>
                    </button>
                </div>
                <div className="control-group mode-selector">
                     <label htmlFor="mode-toggle" className="mode-label">
                        {mode === 'turn-taking' ? '輪流對話' : '持續聆聽'}
                    </label>
                    <button 
                        id="mode-toggle"
                        onClick={() => setMode(m => m === 'turn-taking' ? 'continuous' : 'turn-taking')}
                        className="mode-toggle"
                        disabled={isListening}
                        aria-pressed={mode === 'continuous'}
                        role="switch"
                    >
                        <span className={`toggle-thumb ${mode}`}></span>
                    </button>
                </div>
            </footer>
        </div>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);