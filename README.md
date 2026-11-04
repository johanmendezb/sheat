# SolveSnap

App web local: apuntas la cámara a un ejercicio, tomas la foto y Claude devuelve la solución
(programación o conocimiento general) en la misma página.

## Configuración

1. Instala dependencias: `npm install`
2. Crea `.env.local` a partir de `.env.example` y pon tu clave:
   - `ANTHROPIC_API_KEY`: tu clave de Anthropic (obligatoria).
   - `ANTHROPIC_MODEL`: opcional; por defecto `claude-opus-5-5`.
3. Arranca: `npm run dev` y abre http://localhost:3000

`.env.local` está en `.gitignore`; nunca lo subas al repositorio.

## Usarlo desde el teléfono

Los navegadores solo dan acceso a la cámara en `localhost` o por HTTPS. Para abrirlo desde un
teléfono en la misma red local, arranca con HTTPS:

```
npx next dev --experimental-https
```

y abre `https://<IP-de-tu-computadora>:3000` en el teléfono (acepta el aviso del certificado local).

## Privacidad

No hay base de datos, historial, cookies ni almacenamiento en el navegador. La foto se envía a
Anthropic solo para resolver el ejercicio y el servidor no registra la imagen ni las respuestas.
Para desactivar también la telemetría del CLI de Next.js: `npx next telemetry disable`.
