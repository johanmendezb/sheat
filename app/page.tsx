"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  LANGUAGES,
  type ErrorResponse,
  type Language,
  type Mode,
  type SolveRequest,
  type SolveResponse,
} from "@/lib/types";
import styles from "./page.module.css";

type CameraStatus = "off" | "starting" | "on";
type SolveStatus = "idle" | "solving" | "done" | "error";

const MAX_IMAGE_SIDE = 2000;
const JPEG_QUALITY = 0.85;

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
  // The last photo, kept only in memory so the answer can be refined without a new photo.
  const lastImageRef = useRef<string | null>(null);

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

  async function handleCapture() {
    if (isSolvingRef.current || cameraStatus !== "on") {
      return;
    }
    const image = captureFrame();
    // Release the camera right after the capture; "Tomar otra foto" turns it on again.
    wantsCameraRef.current = false;
    stopCamera();
    if (!image) {
      setSolveStatus("error");
      setSolveError("No se pudo capturar la imagen. Intenta de nuevo.");
      return;
    }

    lastImageRef.current = image;
    setResult(null);
    await requestSolve({ image, mode, language, deepReview });
  }

  async function handleRefine() {
    const refinement = refinementText.trim();
    const image = lastImageRef.current;
    if (isSolvingRef.current || refinement.length === 0 || !image || !result) {
      return;
    }
    const isSuccess = await requestSolve({
      image,
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

  function handleTakeAnotherPhoto() {
    if (isSolvingRef.current) {
      return;
    }
    lastImageRef.current = null;
    setResult(null);
    setSolveError(null);
    setSolveStatus("idle");
    setCopyLabel("Copiar");
    setRefinementText("");
    startCamera();
    cameraSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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

      {!showResultPanel && (
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
            onClick={handleTakeAnotherPhoto}
            disabled={isSolving}
          >
            Tomar otra foto
          </button>
        </section>
      )}
    </main>
  );
}
