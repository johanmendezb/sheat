"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import {
  LANGUAGES,
  MAX_IMAGES,
  MAX_QUESTION_CHARACTERS,
  type ErrorResponse,
  type Language,
  type Mode,
  type SolveRequest,
  type SolveResponse,
} from "@/lib/types";
import styles from "./page.module.css";

type CameraStatus = "off" | "starting" | "on";
type SolveStatus = "idle" | "solving" | "done" | "error";
// "editing" is the textarea: the reviewed transcript or the keyboard dictation fallback.
type VoicePanel = "closed" | "listening" | "editing";

const MAX_IMAGE_SIDE = 2000;
const JPEG_QUALITY = 0.85;
// Seconds before a recognized question is sent on its own.
const VOICE_COUNTDOWN_SECONDS = 2;
const NO_SPEECH_MESSAGE = "No se escuchó nada, intenta de nuevo.";

// The Web Speech API is not in the TypeScript DOM types; only the parts used here.
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function getSpeechLanguage(): string {
  if (navigator.language.toLowerCase().startsWith("es")) {
    return navigator.language;
  }
  return "es-ES";
}

// Joins every result so far (interim ones included) into one text.
function getTranscript(results: SpeechRecognitionResultList): string {
  let transcript = "";
  for (let index = 0; index < results.length; index++) {
    transcript += results[index][0].transcript;
  }
  return transcript;
}

// Safari (including iPad) only exposes the prefixed fullscreen API.
type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};
type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};

function subscribeToFullscreen(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
    document.removeEventListener("webkitfullscreenchange", onChange);
  };
}

function subscribeToNothing() {
  return () => {};
}

function getIsFullscreenSupported(): boolean {
  const webkitDocument = document as WebkitDocument;
  return Boolean(document.fullscreenEnabled || webkitDocument.webkitFullscreenEnabled);
}

function getIsFullscreen(): boolean {
  const webkitDocument = document as WebkitDocument;
  return Boolean(document.fullscreenElement || webkitDocument.webkitFullscreenElement);
}

// The server never renders the fullscreen button, so the first client render matches it.
function getServerFalse(): boolean {
  return false;
}

async function toggleFullscreen() {
  const webkitDocument = document as WebkitDocument;
  try {
    if (getIsFullscreen()) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else {
        await webkitDocument.webkitExitFullscreen?.();
      }
      return;
    }
    const root = document.documentElement as WebkitElement;
    if (root.requestFullscreen) {
      await root.requestFullscreen();
    } else {
      await root.webkitRequestFullscreen?.();
    }
  } catch {
    // The browser refused; the page keeps working with its bars visible.
  }
}

function getCameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "No diste permiso para usar la cámara. Actívalo en el navegador y vuelve a intentar.";
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return "No se encontró ninguna cámara en este dispositivo.";
    }
    if (error.name === "NotReadableError") {
      return "La cámara está siendo usada por otra aplicación.";
    }
  }
  return "No se pudo activar la cámara.";
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("programming");
  const [language, setLanguage] = useState<Language>("JavaScript");
  const [deepReview, setDeepReview] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("off");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [solveStatus, setSolveStatus] = useState<SolveStatus>("idle");
  const [result, setResult] = useState<SolveResponse | null>(null);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copiar");
  const [refinementText, setRefinementText] = useState("");
  // Parts of a tall exercise captured with "+ Parte", only in memory, sent with the final photo.
  const [pendingParts, setPendingParts] = useState<string[]>([]);
  const [partError, setPartError] = useState<string | null>(null);
  const [voicePanel, setVoicePanel] = useState<VoicePanel>("closed");
  // The live or editable text of a voice question, only in memory.
  const [voiceText, setVoiceText] = useState("");
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  // True when the textarea is the keyboard dictation fallback instead of a reviewed transcript.
  const [isDictation, setIsDictation] = useState(false);
  // Seconds left before the reviewed transcript is sent; null when there is no countdown.
  const [countdown, setCountdown] = useState<number | null>(null);
  // The question of the last voice solve, so "Refinar" resends it without images.
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const isFullscreenSupported = useSyncExternalStore(
    subscribeToNothing,
    getIsFullscreenSupported,
    getServerFalse,
  );
  const isFullscreen = useSyncExternalStore(subscribeToFullscreen, getIsFullscreen, getServerFalse);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraSectionRef = useRef<HTMLElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wantsCameraRef = useRef(false);
  const isSolvingRef = useRef(false);
  // The photos of the last exercise, kept only in memory so the answer can be refined
  // without new photos.
  const lastImagesRef = useRef<string[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceTextareaRef = useRef<HTMLTextAreaElement>(null);

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraStatus("off");
  }, []);

  const startCamera = useCallback(async () => {
    if (streamRef.current) {
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("La cámara necesita HTTPS (o localhost) y un navegador compatible.");
      return;
    }
    wantsCameraRef.current = true;
    setCameraError(null);
    setCameraStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      });
      // The page may have been hidden or closed while waiting for permission.
      const isStillWanted = wantsCameraRef.current && !document.hidden;
      if (!isStillWanted) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        setCameraStatus("off");
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraStatus("on");
    } catch (error) {
      wantsCameraRef.current = false;
      setCameraStatus("off");
      setCameraError(getCameraErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        stopCamera();
        // Stopping keeps what was heard; the microphone must not stay on in the background.
        recognitionRef.current?.stop();
      } else if (wantsCameraRef.current) {
        startCamera();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      wantsCameraRef.current = false;
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      streamRef.current = null;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, [startCamera, stopCamera]);

  function captureFrame(): string | null {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }
    const largestSide = Math.max(video.videoWidth, video.videoHeight);
    const scale = Math.min(1, MAX_IMAGE_SIDE / largestSide);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageDataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    // Clear the canvas so the photo does not stay in memory.
    canvas.width = 0;
    canvas.height = 0;
    return imageDataUrl;
  }

  // Sends the photo to the server and shows the answer. Returns true on success.
  async function requestSolve(requestBody: SolveRequest): Promise<boolean> {
    isSolvingRef.current = true;
    setSolveStatus("solving");
    setSolveError(null);
    setCopyLabel("Copiar");

    try {
      const response = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        let errorMessage = "Ocurrió un error. Intenta de nuevo.";
        try {
          const errorBody = (await response.json()) as ErrorResponse;
          if (typeof errorBody.error === "string") {
            errorMessage = errorBody.error;
          }
        } catch {
          // Keep the generic message.
        }
        setSolveError(errorMessage);
        setSolveStatus("error");
        return false;
      }
      const answer = (await response.json()) as SolveResponse;
      setResult(answer);
      setSolveStatus("done");
      return true;
    } catch {
      setSolveError("No hay conexión con el servidor. Revisa tu red e intenta de nuevo.");
      setSolveStatus("error");
      return false;
    } finally {
      isSolvingRef.current = false;
    }
  }

  // Saves the current frame as one part and keeps the camera on for the next part.
  function handleAddPart() {
    if (isSolvingRef.current || cameraStatus !== "on" || pendingParts.length >= MAX_IMAGES - 1) {
      return;
    }
    const image = captureFrame();
    if (!image) {
      setPartError("No se pudo capturar esta parte. Intenta de nuevo.");
      return;
    }
    setPartError(null);
    // Functional update: two quick taps must not go over the limit.
    setPendingParts((parts) => (parts.length >= MAX_IMAGES - 1 ? parts : [...parts, image]));
  }

  function handleDiscardParts() {
    setPendingParts([]);
    setPartError(null);
  }

  async function handleCapture() {
    if (isSolvingRef.current || cameraStatus !== "on") {
      return;
    }
    const image = captureFrame();
    // Release the camera right after the capture; "Tomar otra foto" turns it on again.
    wantsCameraRef.current = false;
    stopCamera();
    const images = image ? [...pendingParts, image] : [];
    setPendingParts([]);
    setPartError(null);
    if (!image) {
      setSolveStatus("error");
      setSolveError("No se pudo capturar la imagen. Intenta de nuevo.");
      return;
    }

    lastImagesRef.current = images;
    setLastQuestion(null);
    setVoiceMessage(null);
    setResult(null);
    await requestSolve({ images, mode, language, deepReview });
  }

  // Opens the textarea so the user can dictate with the keyboard microphone.
  function openDictation() {
    // flushSync renders the textarea now, so focusing it still counts as part of the tap
    // and iOS can open the keyboard.
    flushSync(() => {
      setIsDictation(true);
      setCountdown(null);
      setVoicePanel("editing");
    });
    voiceTextareaRef.current?.focus();
  }

  function handleVoiceStart() {
    if (isSolvingRef.current || voicePanel !== "closed") {
      return;
    }
    setPendingParts([]);
    setPartError(null);
    setVoiceMessage(null);
    setVoiceText("");
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      openDictation();
      return;
    }

    // The browser asks for the microphone here, only after the tap.
    const recognition = new SpeechRecognition();
    recognition.lang = getSpeechLanguage();
    recognition.interimResults = true;
    recognition.continuous = true;
    let transcript = "";
    let errorMessage: string | null = null;
    let shouldFallBack = false;
    recognition.onresult = (event) => {
      transcript = getTranscript(event.results);
      setVoiceText(transcript);
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        errorMessage = "No diste permiso para usar el micrófono. Puedes dictar con el teclado.";
        shouldFallBack = true;
      } else if (event.error === "no-speech") {
        errorMessage = NO_SPEECH_MESSAGE;
      } else if (event.error !== "aborted") {
        errorMessage = "No se pudo usar el reconocimiento de voz. Intenta de nuevo.";
      }
    };
    // Runs after "Detener", after an error, or when recognition ends by itself.
    recognition.onend = () => {
      recognitionRef.current = null;
      const question = transcript.trim();
      if (shouldFallBack) {
        setVoiceMessage(errorMessage);
        setVoiceText("");
        openDictation();
        return;
      }
      if (question.length === 0) {
        setVoiceMessage(errorMessage ?? NO_SPEECH_MESSAGE);
        setVoicePanel("closed");
        return;
      }
      setVoiceText(question);
      setIsDictation(false);
      setCountdown(VOICE_COUNTDOWN_SECONDS);
      setVoicePanel("editing");
    };

    try {
      recognition.start();
    } catch {
      openDictation();
      return;
    }
    recognitionRef.current = recognition;
    setVoicePanel("listening");
  }

  function handleVoiceStop() {
    recognitionRef.current?.stop();
  }

  // The first tap only stops the countdown; with no countdown it closes the panel.
  function handleVoiceCancel() {
    if (countdown !== null) {
      setCountdown(null);
      return;
    }
    setVoicePanel("closed");
    setVoiceText("");
    setVoiceMessage(null);
  }

  async function submitVoiceQuestion() {
    const question = voiceText.trim();
    if (isSolvingRef.current || question.length === 0) {
      return;
    }
    // Same as a photo capture: the camera is released while solving.
    wantsCameraRef.current = false;
    stopCamera();
    setPendingParts([]);
    setPartError(null);
    setCountdown(null);
    setVoicePanel("closed");
    setVoiceText("");
    setVoiceMessage(null);
    lastImagesRef.current = [];
    setLastQuestion(question);
    setResult(null);
    await requestSolve({ question, mode, language, deepReview });
  }

  // An Effect Event reads the latest text and presets when the countdown ends.
  const onCountdownEnd = useEffectEvent(() => {
    submitVoiceQuestion();
  });

  useEffect(() => {
    if (countdown === null) {
      return;
    }
    const timer = setTimeout(() => {
      if (countdown > 1) {
        setCountdown(countdown - 1);
      } else {
        setCountdown(null);
        onCountdownEnd();
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  async function handleRefine() {
    const refinement = refinementText.trim();
    const images = lastImagesRef.current;
    const hasSource = images.length > 0 || lastQuestion !== null;
    if (isSolvingRef.current || refinement.length === 0 || !hasSource || !result) {
      return;
    }
    // A voice answer is refined with the same question and no images.
    const source = lastQuestion !== null ? { question: lastQuestion } : { images };
    const isSuccess = await requestSolve({
      ...source,
      mode,
      language,
      deepReview,
      refinement,
      previousAnswer: JSON.stringify(result),
    });
    if (isSuccess) {
      setRefinementText("");
    }
  }

  function resetResult() {
    lastImagesRef.current = [];
    setLastQuestion(null);
    setVoiceMessage(null);
    setPendingParts([]);
    setPartError(null);
    setResult(null);
    setSolveError(null);
    setSolveStatus("idle");
    setCopyLabel("Copiar");
    setRefinementText("");
  }

  function handleTakeAnotherPhoto() {
    if (isSolvingRef.current) {
      return;
    }
    resetResult();
    startCamera();
    cameraSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // For a voice question that was not understood: listen again instead of opening the camera.
  function handleRetryVoice() {
    if (isSolvingRef.current) {
      return;
    }
    resetResult();
    handleVoiceStart();
  }

  async function handleCopy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopyLabel("Copiado");
    } catch {
      setCopyLabel("No se pudo copiar");
    }
    setTimeout(() => setCopyLabel("Copiar"), 2000);
  }

  const isSolving = solveStatus === "solving";
  // While refining, the current answer stays on screen until the new one arrives.
  const isRefining = isSolving && result !== null;
  const showResultPanel = solveStatus === "done" || solveStatus === "error" || isRefining;
  const isCapturing = solveStatus === "idle";
  const canRefine = result !== null && !result.needsNewPhoto;
  const canShowAddPart = cameraStatus === "on" && !isSolving;
  const shouldRetryVoice = lastQuestion !== null && result !== null && result.needsNewPhoto;

  return (
    <main className={styles.page}>
      <section className={styles.presets} aria-label="Ajustes">
        <div className={styles.segmented} role="group" aria-label="Modo">
          <button
            type="button"
            className={mode === "programming" ? styles.segmentActive : styles.segment}
            aria-pressed={mode === "programming"}
            onClick={() => setMode("programming")}
            disabled={isSolving}
          >
            Programación
          </button>
          <button
            type="button"
            className={mode === "general" ? styles.segmentActive : styles.segment}
            aria-pressed={mode === "general"}
            onClick={() => setMode("general")}
            disabled={isSolving}
          >
            Conocimiento general
          </button>
        </div>

        {mode === "programming" && (
          <label className={styles.languageLabel}>
            <span className={styles.visuallyHidden}>Lenguaje</span>
            <select
              className={styles.languageSelect}
              value={language}
              onChange={(event) => setLanguage(event.target.value as Language)}
              disabled={isSolving}
            >
              {LANGUAGES.map((languageOption) => (
                <option key={languageOption} value={languageOption}>
                  {languageOption}
                </option>
              ))}
            </select>
          </label>
        )}

        {mode === "programming" && (
          <label className={styles.deepToggle}>
            <input
              type="checkbox"
              className={styles.deepToggleInput}
              checked={deepReview}
              onChange={(event) => setDeepReview(event.target.checked)}
              disabled={isSolving}
            />
            Revisión a fondo
          </label>
        )}

        {isFullscreenSupported && (
          <button
            type="button"
            className={styles.fullscreenButton}
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
            aria-pressed={isFullscreen}
            title={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
          >
            ⛶
          </button>
        )}
      </section>

      <section
        ref={cameraSectionRef}
        className={styles.camera}
        aria-label="Cámara"
        hidden={!isCapturing}
      >
        <video ref={videoRef} className={styles.video} playsInline muted autoPlay />
        {cameraStatus !== "on" && (
          <div className={styles.cameraOverlay}>
            {cameraStatus === "starting" ? (
              <span className={styles.spinner} aria-label="Activando cámara" />
            ) : (
              <button type="button" className={styles.secondaryButton} onClick={startCamera}>
                Activar cámara
              </button>
            )}
            {cameraError && <p className={styles.cameraError}>{cameraError}</p>}
          </div>
        )}
      </section>
      <canvas ref={canvasRef} className={styles.hiddenCanvas} />

      {!showResultPanel && (pendingParts.length > 0 || partError) && (
        <div className={styles.partsChip} aria-live="polite">
          {partError ? (
            <span className={styles.errorText}>{partError}</span>
          ) : (
            <span>
              {pendingParts.length === 1
                ? "1 parte guardada"
                : `${pendingParts.length} partes guardadas`}
            </span>
          )}
          {pendingParts.length > 0 && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={handleDiscardParts}
              disabled={isSolving}
            >
              Descartar
            </button>
          )}
        </div>
      )}

      {!showResultPanel && voiceMessage && (
        <p className={styles.voiceMessage} aria-live="polite">
          {voiceMessage}
        </p>
      )}

      {!showResultPanel && voicePanel === "listening" && (
        <section className={styles.voicePanel} aria-label="Escuchando">
          <div className={styles.listeningRow}>
            <span className={styles.pulseDot} aria-hidden="true" />
            <span>Escuchando...</span>
          </div>
          <p className={styles.transcript} aria-live="polite">
            {voiceText || "Habla ahora"}
          </p>
          <button type="button" className={styles.captureButton} onClick={handleVoiceStop}>
            Detener
          </button>
        </section>
      )}

      {!showResultPanel && voicePanel === "editing" && (
        <form
          className={styles.voicePanel}
          aria-label="Pregunta por voz"
          onSubmit={(event) => {
            event.preventDefault();
            submitVoiceQuestion();
          }}
        >
          <label className={styles.visuallyHidden} htmlFor="voice-question">
            Tu pregunta
          </label>
          <textarea
            id="voice-question"
            ref={voiceTextareaRef}
            className={styles.voiceTextarea}
            value={voiceText}
            onChange={(event) => {
              setCountdown(null);
              setVoiceText(event.target.value);
            }}
            onFocus={() => setCountdown(null)}
            maxLength={MAX_QUESTION_CHARACTERS}
            rows={3}
            autoFocus={isDictation}
          />
          {countdown !== null && (
            <p className={styles.voiceHint} aria-live="polite">
              Resolviendo en {countdown} s...
            </p>
          )}
          {countdown === null && isDictation && (
            <p className={styles.voiceHint}>Toca el micrófono del teclado para dictar tu pregunta</p>
          )}
          <div className={styles.voiceActions}>
            {countdown === null && (
              <button
                type="submit"
                className={styles.captureButton}
                disabled={voiceText.trim().length === 0}
              >
                Resolver
              </button>
            )}
            <button type="button" className={styles.addPartButton} onClick={handleVoiceCancel}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      {!showResultPanel && voicePanel === "closed" && (
        <div className={styles.captureRow}>
          <button
            type="button"
            className={styles.captureButton}
            onClick={handleCapture}
            disabled={cameraStatus !== "on" || isSolving}
          >
            {isSolving ? (
              <>
                <span className={styles.spinnerSmall} aria-hidden="true" />
                Resolviendo...
              </>
            ) : (
              "Tomar foto"
            )}
          </button>
          {canShowAddPart && (
            <button
              type="button"
              className={styles.addPartButton}
              onClick={handleAddPart}
              disabled={pendingParts.length >= MAX_IMAGES - 1}
              aria-label="Capturar esta parte y seguir"
              title="Capturar esta parte y seguir"
            >
              + Parte
            </button>
          )}
          <button
            type="button"
            className={styles.addPartButton}
            onClick={handleVoiceStart}
            disabled={isSolving}
            aria-label="Preguntar por voz"
            title="Preguntar por voz"
          >
            Voz
          </button>
        </div>
      )}

      {showResultPanel && (
        <section className={styles.result} aria-live="polite">
          {solveError && <p className={styles.errorText}>{solveError}</p>}

          {result && result.needsNewPhoto && (
            <p className={styles.message}>{result.message}</p>
          )}

          {result && !result.needsNewPhoto && result.type === "programming" && (
            <>
              <p className={styles.exercise}>{result.exercise}</p>
              <div className={styles.codeBlock}>
                <div className={styles.codeHeader}>
                  <span className={styles.codeLanguage}>{result.language}</span>
                  <button
                    type="button"
                    className={styles.copyButton}
                    onClick={() => handleCopy(result.code)}
                  >
                    {copyLabel}
                  </button>
                </div>
                <pre className={styles.code}>
                  <code>{result.code}</code>
                </pre>
              </div>
              {result.explanation && <p className={styles.explanation}>{result.explanation}</p>}
              {result.edgeCases && result.edgeCases.length > 0 && (
                <div>
                  <h2 className={styles.subheading}>Casos borde revisados</h2>
                  <ul className={styles.edgeCases}>
                    {result.edgeCases.map((edgeCase, index) => (
                      <li key={index}>{edgeCase}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.expectedOutput !== null && (
                <div>
                  <h2 className={styles.subheading}>Salida esperada</h2>
                  <pre className={styles.output}>{result.expectedOutput}</pre>
                </div>
              )}
            </>
          )}

          {result && !result.needsNewPhoto && result.type === "general" && (
            <>
              <p className={styles.answer}>{result.answer}</p>
              {result.explanation && <p className={styles.explanation}>{result.explanation}</p>}
            </>
          )}

          {canRefine && (
            <form
              className={styles.refineForm}
              onSubmit={(event) => {
                event.preventDefault();
                handleRefine();
              }}
            >
              <label className={styles.visuallyHidden} htmlFor="refinement">
                Indicación para refinar la respuesta
              </label>
              <input
                id="refinement"
                type="text"
                className={styles.refineInput}
                value={refinementText}
                onChange={(event) => setRefinementText(event.target.value)}
                placeholder="Ej: usa un bucle for, explica más el paso 2, responde solo la letra"
                maxLength={500}
                autoComplete="off"
                disabled={isSolving}
              />
              <button
                type="submit"
                className={styles.refineButton}
                disabled={isSolving || refinementText.trim().length === 0}
              >
                {isSolving ? (
                  <>
                    <span className={styles.spinnerSmall} aria-hidden="true" />
                    Resolviendo...
                  </>
                ) : (
                  "Refinar"
                )}
              </button>
            </form>
          )}

          <button
            type="button"
            className={styles.captureButton}
            onClick={shouldRetryVoice ? handleRetryVoice : handleTakeAnotherPhoto}
            disabled={isSolving}
          >
            {shouldRetryVoice ? "Intentar de nuevo" : "Tomar otra foto"}
          </button>
        </section>
      )}
    </main>
  );
}
