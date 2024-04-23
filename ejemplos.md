```bash
# ejemplos de usos de aicode "x"
# considera siempre la carpeta actual y sus archivos como referencia

# la primera vez, aicode detecta si hay una API key de OpenAI, si no la hay, la pide y la guarda en una bd interna encriptada
aicode "cualquier cosa"
#[aicode]: (si no hay API key de OpenAI, la pide y la guarda en bd interna encriptada)

aicode "pideme/configura todas las API keys que puedas necesitar"
#[aicode]: pregunta a usuario por cada API key que soportan los templates y las guarda en bd interna encriptada
#[aicode]: tienes un presupuesto diario maximo por API key? (si no responde o non-interactive, asume 1000 usd)

aicode "creame un perfil de usuario para pablo@x.com"
#[aicode]: ¿cual es tu nombre?
#[aicode]: ¿cual es tu teléfono?

aicode "usa de contexto la carpeta que tengo abierta en mi escritorio, y dime que documentos hablan de inmobiliarias"

#opens the user camera, takes a picture and compares it to a previous picture to determine if the user has changed (osascript, history per template db)
aicode "como me veo hoy"

aicode "busca en internet información sobre lo que tengo en la mano"

#describe el estilo de escribir correos del usuario y la asocia al perfil de usuario en bd interna
aicode "lee mis correos enviados y asigname un perfil de escritura"
#[aicode]: ¿cual es tu correo? (si hay más de uno en perfil)
#[aicode]: ¿cual es tu clave? (si no está guardada en bd interna encriptada)

aicode "envia un correo usando mi estilo de escritura a Mauricio Rojas, pidiendo una cotización de desarrollo de software"

# inicializa un git en la carpeta actual
aicode "prepara un control de versiones"

# haz un commit de los cambios en la carpeta actual y los empuja
aicode "guarda los cambios en github"

# inventa un nombre para una rama de trabajo y crea una rama en el repositorio
aicode "crea una rama para trabajar en un nuevo feature de la app"

aicode "crea un PR acorde a los cambios realizados"
#[aicode]: (si estamos en un branch asume que es un PR a master)
#[aicode]: (si no estamos en un branch, pregunta por el branch origen)

# navega a Enecon con playwright y toma una captura de pantalla que guarda localmente
aicode "toma una captura de pantalla de la página web de Enecon Chile"
#[aicode]: es la url www.enecon.cl? (si no responde o non-interactive, asume que si)
#[aicode]: nombre del archivo? (si no responde o non-interactive, inventa nombre y lo indica)

# crea un programa (siempre nodejs) que haga algo con los archivos indicados
# guarda el programa en la carpeta actual y en su bd interna (sqlite o vector local) para usarlo en el futuro
aicode "crea un programa que haga un resumen de un documento" "resumen.js"
# al ejecutar el script con aicode, este obtiene acceso al contexto y metodos de aicode
aicode "ejecuta resumen.js" "documento.docx"

# determina el costo de ejecutar este comando (--cost, -c)
# activa modo interactivo (--interactive, -i), solicita proceder con cada paso

# haz un resumen de todos los documentos en la carpeta
# este template llama el template 'crear programa CAN' y luego lo ejecuta para cada archivo
aicode "haz un resumen de lo que contiene esta carpeta"

# guarda las credenciales en forma encriptada en una bd interna (sqlite o vector local) para usarlas en el futuro
aicode "monitorea mi correo y dime si hay algo nuevo importante"
#[aicode]: ¿cual es tu correo?
#[aicode]: ¿cual es tu clave?

# zipea los archivos que corresponden a un script y los envía por correo al mail indicado
# usando el correo/clave guardado en la bd interna
aicode "manda los scripts de esta carpeta desde pablo@creador.cl a mauricio@creador.cl"
#[aicode]: que correo usamos para enviar los archivos? (si ya estaba reg local no pregunta clave) 

# extrae los emails de cada uno de los documentos en la carpeta actual
aicode "extrae los emails de los documentos" > emails.txt

# revisa el correo
aicode "avisame si me escribe alguien a mi correo pidiendo una cotización de desarrollo al +56912345678"
#[aicode]: ¿cual es tu correo? (si ya estaba reg local no pregunta clave)
#[aicode]: (si no existe llave de twilio, la pide y guarda en bd local encriptada)
#[aicode]: evento registrado; lo ejecuta cada 5 minutos

# revisa procesos de aicode que están asociados al correo indicado (ej. chequeo de correos recibidos por solitudes de cotizaciones para apps móviles)
aicode "que actividades están asociadas a mi correo pablo@x.cl"

# agrega tarea de chequeo a array con otras tareas asociadas al correo indicado
aicode "si me escribe Mauricio Rojas a mi correo de pablo@x.cl con una fecha para reunirnos, agendar la reunión en mi calendario"

# crea un archivo con las cotizaciones de la carpeta actual
aicode "extrae las cotizaciones de mi correo pablo@x.cl y crea un archivo .doc con ellas"

aicode "revisa la página web de Enecon y dime las noticias de este mes"

# busca en google la página de 'Emol', crea un script para los titulos de las noticias y sus links, evaluando si son positivas o negativas y retorna solo las positivas junto con sus contenidos
aicode "dime que noticias positivas hay en la página web de Emol"

# ejecuta el template de arriba, ejecuta un resumen para cada una, solicita crear una narración para el texto completo generado y luego genera un audio usando Elevan Labs (asumiendo tiene un API key, sino lo pregunta y guarda encriptado en bd interna)
aicode "narrame un resumen de las noticias positivas de la página web de Emol"

# revisa las consideraciones legales según la ley chilena de lo que dice el documento 'propuesta.docx'
aicode "revisa las consideraciones legales según la ley chilena de lo que dice el documento 'propuesta.docx'"

# prende el microfono y escucha lo que pida
aicode "escuchame"

aicode "llama a la peluquería y pide hora para mañana a las 10:00, para Juan Pérez"

aicode "crea una pagina web"
aicode "crea una pagina web para ofrecer servicios de desarrollo de software, de estilo moderno y minimalista"
#[aicode]: ¿cual es el nombre de la empresa?
#[aicode]: quieres usar react o vue? (si no responde o non-interactive, usa react)

aicode "agrega un formulario de contacto a la página web"

aicode "agrega una página de servicios"

aicode "agrega pruebas unitarias para cada componente" #(react)

aicode "crea un archivo docker para este proyecto"

aicode "crea un dockerFile para un servidor mySQL" #default
#[aicode]: que usuario y contraseña quieres usar? (si no responde o non-interactive, usa root y root)

aicode "muestrame donde se usa la imagen xx.jpg"
#[aicode]: (busca el source_tree por archivo más cercano, y retorna donde se usa el archivo dentro de los archivos de la carpeta actual)

# devuelve numero de imagenes en carpeta y subcarpeta actual
aicode "cuantas imagenes hay aqui?"

aicode "crea una presentación con los documentos de la carpeta actual sobre inmobiliarias"
#[aicode]: de cuantos slides quieres la presentación? (si no responde o non-interactive, calcula solo)
#[aicode]: (crea un archivo 'reveal' en subcarpeta)

aicode "crea y muestra una presentación con los documentos de la carpeta actual sobre ventas"

# crea una presentación en mp4 usando reveal sobre inmobiliarias
aicode "crea un video con los documentos de la carpeta actual sobre inmobiliarias"
#[aicode]: quieres que tenga narración ? (si no responde o non-interactive, no tiene)
#[aicode]: quieres que tenga música de fondo? (si no responde o non-interactive, no tiene)

aicode "crea un avatar que hable sobre lo que contiene la carpeta en japones en MP4"

aicode "analiza el archivo finanzas.xlsx, hoja 'ventas' y dime el total de ventas"

aicode "dime el valor actual del Bitcoin"

aicode "monitorea el valor del Bitcoin cada 5 minutos y avisame cada vez que suba o baje un 5% a mi telefono"

aicode "crea un script"

# retorna los archivos de la carpeta actual que hablan de inmobiliarias
# crea un resumen de cada archivo y lo pasa como contexto
aicode "que archivos hablan de inmobiliarias?"

```