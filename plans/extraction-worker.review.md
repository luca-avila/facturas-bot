## Qué hace este cambio
Antes: una foto subida quedaba en *Procesando* para siempre. Nadie la leía y no sumaba a ninguna deuda.
Ahora: un proceso aparte, el *worker*, manda las fotos a Claude Haiku 5.5, que lee el documento. El documento pasa solo a *Sin revisar*, donde cuenta en el saldo, o a *Error*, donde no cuenta, con los motivos en castellano. La pantalla nueva *A resolver* lista los documentos en *Error*, *Resumen* avisa cuántos son y cuánto suman, y *Documento* muestra lo leído (proveedor, fechas, impuestos, ítems) en *Datos*, junto a *Foto*. Mientras está *Procesando*, *Documento* vuelve a consultar cada 3 s.

## Cómo funciona
1. El worker toma una tarea pendiente (un *job*). Si otro proceso la tiene bloqueada, la saltea en vez de esperar. Antes de enviar nada, comprueba que el documento no esté borrado, que siga en *Procesando* y que sus fotos no pasen los 22 MB. Si algo falla, cierra el job sin llamar al modelo. `claim` (backend/src/extraction/extraction-worker.ts)
2. Marca el job "en curso" con un *lease* (un permiso de 5 minutos) y suma 1 al número de intento. Ese número es una ficha: toda escritura posterior comprueba que sigue siendo suya, así un worker trabado no pisa a otro. Todo esto se guarda antes de la llamada, para no tener la base bloqueada mientras el modelo responde. `claim`
3. Lee las fotos tal como se guardaron y llama al modelo. Un error de red o de clave, una respuesta cortada o un JSON inválido cuentan como intento fallido. `ExtractionCall.run` (backend/src/extraction/extraction-call.ts)
4. Si el intento falla, reintenta a los 30 s, 2 min y 8 min. Al cuarto fallo, el documento va a *Error* con "No pudimos leer el documento". `failAttempt`, `ExtractionWriter.fail` (extraction-writer.ts)
5. Si sale bien, acomoda cada valor leído a su columna: lo que no entra queda vacío, nunca da error. Busca al proveedor por CUIT. Si el CUIT es nuevo y válido y hay un nombre impreso, crea el proveedor sin plazo. `mapExtraction` (extraction-mapping.ts), `resolveSupplier` (extraction-writer.ts)
6. Calcula el vencimiento solo con el plazo del proveedor, nunca con una fecha impresa, y decide los problemas: proveedor sin identificar, falta el total, falta la fecha, proveedor sin plazo o número repetido. `checkExtraction` (extraction-checks.ts)
7. Escribe todo en una transacción (se guarda entero o nada): el documento, los ítems, los impuestos, una entrada de auditoría sin usuario y la respuesta cruda del modelo, que después la base no deja cambiar. Si un duplicado pasa el chequeo previo, lo frena el índice único (una regla de la base que impide dos documentos con el mismo proveedor, tipo, letra y número), y el documento se reescribe en *Error* con `duplicate_number`. `ExtractionWriter.write`
8. Las pantallas leen `GET /api/error-documents` y el campo `errors` de `GET /api/suppliers`, que se calculan en el backend con las mismas filas. `BalancesService.errorDocuments`, `summarizeErrors` (backend/src/balances/)

## Decisiones que tomó el código
- El worker es su propio proceso (`npm run start:worker`), así el backend nunca tiene la clave de la API ni puede llamar al modelo. La alternativa era correrlo dentro del backend.
- La dirección de la API está fija en el código y los reintentos propios de la librería de Anthropic están apagados. Una variable de entorno no puede desviar las fotos a otro servidor, y los únicos reintentos son los cuatro intentos del worker.
- Una nota de crédito de un proveedor nuevo entra directo a *Sin revisar* y baja el saldo de ese proveedor, como aceptó la pregunta 14. Una factura de un proveedor nuevo siempre se detiene en *Error*, porque el proveedor todavía no tiene plazo.
- El aviso de *Error* suma los totales sin contar las notas de crédito, porque muestra cuánta deuda falta en el saldo, no cuánto crédito.

## Qué prueban los tests
- La llamada: el pedido lleva exactamente 4 campos, las fotos van en orden y no hay parámetros extra. Un 529 se pide una sola vez, cada falla cuenta como intento fallido y la clave no aparece nunca.
- La toma y los reintentos: el orden, el lease vivo o vencido, el job bloqueado que se saltea, las esperas de 30 s, 2 min y 8 min, y el cuarto fallo a *Error*. También el documento borrado antes o durante la llamada, las fotos demasiado grandes y la foto que no se puede leer.
- El worker trabado: su resultado tardío se descarta, sea un éxito o un fallo. El caso del fallo lo agregó esta revisión.
- La escritura: el proveedor conocido, nuevo, sin nombre, con el CUIT del restaurante o con un CUIT inválido; remitos, notas de crédito, faltantes en orden y una foto que no es un documento. En duplicados: otros separadores, borrado, en *Error*, otra letra, otro tipo, otro proveedor y sin letra (este último lo agregó esta revisión), más el duplicado que solo frena el índice y correr la misma tarea dos veces.
- Las reglas de la base, la configuración, la auditoría sin usuario, las lecturas nuevas y el flujo completo por HTTP hasta registrar un pago.
- Sin cubrir: las pantallas, que no tienen tests de componentes, igual que en slices anteriores. Importa poco, porque solo muestran lo que decide el backend.

## Cómo probarlo a mano
1. Completá `ANTHROPIC_API_KEY`, `LLM_MODEL=claude-haiku-5-5` y `RESTAURANT_CUIT` en `.env`. Antes de arrancar el worker, borrá las subidas en cola que no quieras enviar: el worker manda todo lo que está en cola.
2. Levantá el backend, el frontend y `npm run start:worker`. Subí una muestra de `samples/` de un proveedor que la app no conoce. *Documento* pasa solo a *Error* con "El proveedor no tiene plazo de pago…", *A resolver* lo lista y *Resumen* muestra el aviso.
3. Ponele un plazo a ese proveedor y subí otro documento suyo, con datos inventados. Queda en *Sin revisar*, vence en la fecha de emisión más el plazo, y *Datos* muestra los ítems y los impuestos.
4. Subí una foto que no sea un documento. Termina en *Error* con "Esto no parece una factura…".

## Merge danger
- Door: one-way. Manda fotos de documentos financieros a Anthropic, crea proveedores que la app todavía no deja borrar y decide qué documento es un duplicado.
- Blast radius: si falla la detección de duplicados, la misma factura cuenta dos veces y la deuda con ese proveedor aparece inflada sin ningún aviso. Si se lee mal un CUIT que igual resulta válido, aparece en *Resumen* un proveedor que no existe y no se puede borrar. Hoy no hay documentos reales en la app: el riesgo empieza con la primera subida real.
- Look closely at:
  - `createAnthropicClient` (anthropic-client.ts): `baseURL`, `apiKey`, `maxRetries: 0` y `logLevel` explícitos. Son lo que impide mandar las fotos a otro lado.
  - `ExtractionWorker.claim`: el chequeo de documento borrado o fuera de *Procesando* va antes de cualquier llamada.
  - `ExtractionWriter.writeIn`: primero comprueba la ficha del job, después bloquea el documento y verifica que siga en *Procesando*. Es lo que impide pisar datos que ya tiene un documento.
  - `DuplicateNumberCheck.exists` y el reintento por `documents_number_unique` en `write`: tienen que seguir el mismo criterio que el índice único.
  - `resolveSupplier`: nunca debe resolver el CUIT del restaurante ni crear un proveedor sin nombre impreso.
- Open questions:
  - El código se aparta del plan en tres puntos. Usa el esfuerzo `medium` aunque `low` también pasó las cinco muestras (system-design.md lo anota como decisión tuya). El prompt suma dos reglas, para las líneas "Neto" y las percepciones, y sigue en `PROMPT_VERSION = '1'`. El gate no prueba `max` salvo que se lo pidan. ¿Confirmás los tres? Después del merge, cualquier cambio al prompt tiene que subir la versión.
  - Un documento borrado justo cuando el worker lo toma se envía igual, aunque el resultado no se guarda. El chequeo no puede tener el documento bloqueado durante la llamada sin retener la base todo ese tiempo. ¿Lo aceptás?
  - Si un documento se borra mientras está abierto en *Procesando*, la pantalla sigue en *Procesando* y consulta cada 3 s sin parar, porque toma el 404 como una falla pasajera. ¿Debería mostrar "No encontramos este documento"?
  - Antes del slice 8: revisar en la Claude Console cuánto tiempo guarda Anthropic los datos de la organización, y decidir si quitar el EXIF, que puede incluir la ubicación, de las fotos que se subieron sin comprimir.
