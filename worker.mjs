/**
 * AppInitDev MCP V3 - Cloudflare Workers Free, lectura pública solamente.
 * Implementación ligera de MCP Streamable HTTP: 2026-07-28 y versiones heredadas 2025.
 * No requiere dependencias, npm, Node.js en Hostinger, KV ni base de datos.
 * Fuentes: https://appinitdev.com/datos/{apps,conocimiento,secciones}.json
 */

const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const PRIMARY_VERSION = VERSIONS[0];
const RELEASE = '3.0.1';
const DATA_ORIGIN = 'https://appinitdev.com/datos/';
const ALLOWED_ORIGINS = new Set(['https://appinitdev.com', 'https://www.appinitdev.com']);
const RESPONSE_HEADERS = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
const DATA_KEYS = new Set(['apps', 'conocimiento', 'secciones']);
// Control antialuvión orientativo por isolate; NO sustituye rate limiting global de Cloudflare WAF.
const RATE_WINDOWS = new Map();
function overLimit(request){
  const addr=request.headers.get('CF-Connecting-IP');
  if(!addr)return false; // Solo confiamos en cabecera suministrada por Cloudflare.
  const now=Date.now(),old=RATE_WINDOWS.get(addr);
  if(RATE_WINDOWS.size>800){for(const [k,v] of RATE_WINDOWS){if(now-v.at>60000)RATE_WINDOWS.delete(k);}}
  if(!old||now-old.at>60000){if(RATE_WINDOWS.size<1500)RATE_WINDOWS.set(addr,{at:now,n:1});return false;}
  old.n++;return old.n>45;
}


const tools = [
  {name:'buscar_apps', description:'Buscar aplicaciones del catálogo oficial público de AppInitDev, con enlaces a la fuente.', inputSchema:{type:'object', properties:{consulta:{type:'string',minLength:1,maxLength:120},limite:{type:'integer',minimum:1,maximum:20}},required:['consulta'],additionalProperties:false}},
  {name:'obtener_app', description:'Obtener ficha de aplicación mediante paquete Android o slug exacto.', inputSchema:{type:'object',properties:{identificador:{type:'string',minLength:1,maxLength:130}},required:['identificador'],additionalProperties:false}},
  {name:'buscar_conocimiento',description:'Buscar artículos, guías e investigaciones de AppInitDev con sus URLs originales.',inputSchema:{type:'object',properties:{consulta:{type:'string',minLength:1,maxLength:120},limite:{type:'integer',minimum:1,maximum:20}},required:['consulta'],additionalProperties:false}},
  {name:'listar_secciones',description:'Listar áreas públicas y herramientas de AppInitDev.',inputSchema:{type:'object',properties:{categoria:{type:'string',enum:['todas','apps','articulos','herramientas']}},additionalProperties:false}},
  {name:'comparar_apps',description:'Comparar dos a cinco fichas oficiales sin inferir funcionalidades ausentes.',inputSchema:{type:'object',properties:{identificadores:{type:'array',minItems:2,maxItems:5,items:{type:'string',minLength:1,maxLength:130}}},required:['identificadores'],additionalProperties:false}},
  {name:'obtener_articulo',description:'Recuperar texto público de un artículo de AppInitDev listado en el catálogo y devolver la fuente original; puede limitar longitud.',inputSchema:{type:'object',properties:{url:{type:'string',minLength:20,maxLength:500},max_caracteres:{type:'integer',minimum:500,maximum:16000}},required:['url'],additionalProperties:false}},
  {name:'buscar_texto_completo',description:'Búsqueda por términos del HTML realmente indexado (sin inventar contenido), con fragmentos y temas; diferencia registros con texto local de solo metadatos.',inputSchema:{type:'object',properties:{consulta:{type:'string',minLength:2,maxLength:160},limite:{type:'integer',minimum:1,maximum:10},tema:{type:'string',maxLength:70},solo_html:{type:'boolean'}},required:['consulta'],additionalProperties:false}},
  {name:'listar_temas',description:'Lista la clasificación automática y la cobertura de la búsqueda; las etiquetas son heurísticas, no revisiones editoriales.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'auditoria_conocimiento',description:'Resumen de la cobertura real y calidad de fuentes; no equivale a indexación en buscadores.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'estado_indice',description:'Estadísticas y procedencia del índice generado, sin datos privados.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'obtener_identidad',description:'Identidad pública declarada de AppInitDev: desarrollador, sitio y perfil de Google Play; no conecta Play Console.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'listar_redes_sociales',description:'Enlaces sociales y perfiles públicos declarados en el sitio de AppInitDev, sin afirmar verificación externa.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'listar_apps_desarrollador',description:'Vincula los paquetes Android del catálogo local con sus fichas AppInitDev y enlaces a Google Play. No verifica publicación actual.',inputSchema:{type:'object',properties:{limite:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}},
  {name:'resumen_catalogo',description:'Contar registros disponibles en los tres catálogos publicados.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'explorar_relaciones',description:'Grafo con relaciones entre AppInitDev, apps y artículos enlazados por slug en ruta (relaciones heurísticas etiquetadas).',inputSchema:{type:'object',properties:{consulta:{type:'string',maxLength:120},paquete:{type:'string',maxLength:150},limite:{type:'integer',minimum:1,maximum:10}},additionalProperties:false}},
  {name:'consultar_idiomas',description:'Idiomas declarados en HTML locales; los documentos sin HTML quedan como no_determinado.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'estado_play_store',description:'Resumen de comparación con exportaciones autorizadas de Google Play, nunca verificación en tiempo real.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'resumen_impacto_ia',description:'Estadísticas agregadas importadas por el propietario; las citas Bing y el tráfico GSC son indicadores distintos.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'evaluar_reconocimiento',description:'Estado del laboratorio determinista de cobertura de datos; NO evalúa a modelos de IA externos.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {
    name: 'obtener_icono_app',
    description: 'Obtiene y devuelve la imagen PNG oficial de una aplicación AppInitDev, sin usar imágenes alternativas.',
    inputSchema: {
      type: 'object',
      properties: {
        identificador: {
          type: 'string',
          description: 'Paquete Android o slug de la aplicación.',
          minLength: 1,
          maxLength: 130
        }
      },
      required: ['identificador'],
      additionalProperties: false
    }
  }

];
// -----------------------------------------------------------------------------
// Metadatos MCP: claridad para clientes, seguridad declarativa y documentacion.
// Todos los metodos actuales consultan datos publicos sin escribir sobre ellos.
// Las anotaciones no son controles de acceso: la seguridad sigue en el Worker.
// -----------------------------------------------------------------------------
const TOOL_PARAMETER_HELP = {
  buscar_apps: {
    consulta: 'Nombre, categoria o funcion de una app. Ejemplos: Vault Wallet, archivos, fotos.',
    limite: 'Cantidad maxima de aplicaciones devueltas, entre 1 y 20 (predeterminado: 10).'
  },
  obtener_app: {
    identificador: 'ID de paquete Android o slug exacto de una aplicacion del catalogo publico.'
  },
  buscar_conocimiento: {
    consulta: 'Terminos de busqueda de articulos, guias o investigaciones de AppInitDev.',
    limite: 'Cantidad maxima de documentos devueltos, entre 1 y 20 (predeterminado: 10).'
  },
  listar_secciones: {
    categoria: 'Categoria opcional para filtrar las secciones: todas, apps, articulos o herramientas.'
  },
  comparar_apps: {
    identificadores: 'Arreglo de 2 a 5 paquetes Android o slugs exactos de aplicaciones para comparar.'
  },
  obtener_articulo: {
    url: 'URL HTTPS canonica de un articulo listado en el catalogo publico appinitdev.com.',
    max_caracteres: 'Longitud maxima del texto devuelto, entre 500 y 16000 caracteres (predeterminado: 12000).'
  },
  buscar_texto_completo: {
    consulta: 'Palabras significativas que se buscaran en el indice del contenido HTML publicado.',
    limite: 'Numero maximo de coincidencias, entre 1 y 10 (predeterminado: 5).',
    tema: 'Etiqueta tematica opcional, tal como aparece en las clasificaciones del indice.',
    solo_html: 'Si es true, restringe resultados a documentos cuyo HTML se indexo completamente.'
  },
  listar_apps_desarrollador: {
    limite: 'Cantidad maxima de aplicaciones del desarrollador, entre 1 y 100 (predeterminado: 100).'
  },
  obtener_icono_app: {
    identificador: 'Paquete Android o slug exacto de la aplicación cuyo ícono oficial se solicita.'
  },
  explorar_relaciones: {
    consulta: 'Nombre, slug o texto opcional para buscar relaciones entre apps y articulos.',
    paquete: 'Paquete Android opcional de la aplicacion cuyas relaciones se consultaran.',
    limite: 'Cantidad maxima de relaciones devueltas, entre 1 y 10 (predeterminado: 5).'
  }
};

const TOOL_TITLES = {
  buscar_apps: 'Buscar aplicaciones',
  obtener_app: 'Obtener ficha de aplicacion',
  buscar_conocimiento: 'Buscar guias y articulos',
  listar_secciones: 'Listar secciones del sitio',
  comparar_apps: 'Comparar aplicaciones',
  obtener_articulo: 'Leer articulo publicado',
  buscar_texto_completo: 'Buscar en texto completo',
  listar_temas: 'Listar temas del indice',
  auditoria_conocimiento: 'Auditar cobertura documental',
  estado_indice: 'Consultar estado del indice',
  obtener_identidad: 'Consultar identidad de AppInitDev',
  listar_redes_sociales: 'Consultar redes sociales',
  listar_apps_desarrollador: 'Listar aplicaciones del desarrollador',
  resumen_catalogo: 'Resumen del catalogo',
  explorar_relaciones: 'Explorar relaciones de contenido',
  consultar_idiomas: 'Consultar idiomas del sitio',
  estado_play_store: 'Consultar resumen de Google Play',
  resumen_impacto_ia: 'Consultar indicadores de impacto IA',
  evaluar_reconocimiento: 'Consultar cobertura del laboratorio IA'
};

// Se mejora tools/list sin cambiar los nombres ni la ejecucion de tools/call.
for (const tool of tools) {
  tool.title = TOOL_TITLES[tool.name] || tool.name.replaceAll('_', ' ');
  tool.annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };

  for (const [name, schema] of Object.entries(tool.inputSchema?.properties || {})) {
    const explanation = TOOL_PARAMETER_HELP[tool.name]?.[name];
    if (!explanation) throw new Error('Falta descripcion MCP: ' + tool.name + '.' + name);
    schema.description = explanation;
    if (name === 'identificadores' && schema.items) {
      schema.items.description = 'Paquete Android o slug de una aplicacion de AppInitDev.';
    }
  }
}
// Recursos de tamaño acotado y rutas fijas (no funciona como proxy arbitrario).
const EXTRA_PATHS = new Set([
  'relaciones/resumen.json','relaciones/apps.json','idiomas/resumen.json',
  'play-store/resumen.json','impacto/resumen.json','reconocimiento/resumen.json'
]);
const extraCache=new Map();
async function readExtra(path){
  if(!EXTRA_PATHS.has(path))throw Error('RECURSO_NO_PERMITIDO');
  const old=extraCache.get(path);if(old&&Date.now()-old.at<120000)return old.data;
  const res=await fetch(DATA_ORIGIN+path,{headers:{Accept:'application/json'},cf:{cacheEverything:true,cacheTtl:120},signal:AbortSignal.timeout(6000)});
  if(!res.ok)throw Error('RECURSO_NO_PUBLICADO');
  if(Number(res.headers.get('Content-Length')||0)>400000)throw Error('RECURSO_DEMASIADO_GRANDE');
  const txt=await res.text();if(txt.length>400000)throw Error('RECURSO_DEMASIADO_GRANDE');
  const data=JSON.parse(txt);extraCache.set(path,{at:Date.now(),data});return data;
}
const RESOURCES=[
 {uri:'appinitdev://identidad',name:'Identidad AppInitDev',description:'Identidad pública declarada',mimeType:'application/json',source:'identidad'},
 {uri:'appinitdev://calidad',name:'Calidad documental',description:'Cobertura real del índice',mimeType:'application/json',source:'calidad'},
 {uri:'appinitdev://relaciones',name:'Relaciones del catálogo',description:'Resumen del grafo de conocimiento',mimeType:'application/json',source:'relaciones/resumen.json'},
 {uri:'appinitdev://idiomas',name:'Idiomas presentes',description:'Idiomas verificados o no determinados',mimeType:'application/json',source:'idiomas/resumen.json'},
 {uri:'appinitdev://google-play',name:'Comparación Play',description:'Resumen de exportaciones locales',mimeType:'application/json',source:'play-store/resumen.json'},
 {uri:'appinitdev://impacto',name:'Impacto IA',description:'Métricas agregadas, si se importaron',mimeType:'application/json',source:'impacto/resumen.json'},
 {uri:'appinitdev://reconocimiento',name:'Reconocimiento de datos',description:'Prueba local determinista',mimeType:'application/json',source:'reconocimiento/resumen.json'}
];
const PROMPTS=[
 {name:'conocer_appinitdev',title:'Conocer AppInitDev',description:'Resumen con fuentes verificables del desarrollador, apps y sus redes declaradas',arguments:[]},
 {name:'buscar_aplicacion',title:'Buscar una aplicación',description:'Investigar una necesidad del usuario con paquetes y enlaces Play',arguments:[{name:'necesidad',description:'Función que buscas',required:true}]},
 {name:'investigar_tema',title:'Investigar un tema',description:'Buscar artículos originales y citar sus URLs canónicas',arguments:[{name:'tema',description:'Tema técnico de interés',required:true}]}
];
function promptGet(name,args={}){
  const spec=PROMPTS.find(p=>p.name===name);if(!spec)return null;
  const val=(spec.arguments[0]?.name&&args[spec.arguments[0].name])||'';
  if(spec.arguments.length&&(typeof val!=='string'||!val.trim()||val.length>120))throw Error('Argumento de prompt inválido (1-120 caracteres).');
  const req=name==='conocer_appinitdev'?'Usa obtener_identidad y listar_apps_desarrollador; distingue identidad declarada de verificación externa. Incluye perfil Google Play y fuentes.':
    name==='buscar_aplicacion'?'Busca aplicaciones de AppInitDev relacionadas con la necesidad: '+val+'. Usa buscar_apps/obtener_app y cita Play Store; no inventes funciones ni publicación.':
    'Investiga el tema: '+val+'. Usa buscar_texto_completo y obtener_articulo, atribuye las fuentes originales y aclara si hay solo metadatos.';
  return {description:spec.description,messages:[{role:'user',content:{type:'text',text:req}}]};
}
const cached = new Map();
function json(obj, status=200, extra={}) {
  return new Response(JSON.stringify(obj), {status,headers:{...RESPONSE_HEADERS,...extra}});
}
function rpcResult(id, result, modern=false) {
  return json({jsonrpc:'2.0',id,result:modern?{...result,resultType:'complete',_meta:{...(result._meta||{}),'io.modelcontextprotocol/serverInfo':{name:'appinitdev-mcp-cloudflare',version:RELEASE}}}:result});
}
function rpcError(id, code, message, status=200) {return json({jsonrpc:'2.0',id,error:{code,message}},status);}
function textResult(obj) {return {content:[{type:'text',text:JSON.stringify(obj)}]};}
function norm(s) {return String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function contains(s, term) {return norm(s).includes(norm(term));}
function isString(x,max=120) {return typeof x==='string'&&x.trim().length>0&&x.length<=max;}
function limit(n){return n===undefined?10:(Number.isInteger(n)&&n>=1&&n<=20?n:null);}
async function readData(key) {
  if(!DATA_KEYS.has(key))throw Error('CATALOGO_DESCONOCIDO');
  const old=cached.get(key);
  if(old&&Date.now()-old.at<120000)return old.items;
  const url=DATA_ORIGIN+key+'.json';
  const response=await fetch(url,{headers:{'Accept':'application/json'},cf:{cacheTtl:120,cacheEverything:true},signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw Error('CATALOGO_NO_DISPONIBLE');
  const payload=await response.json();
  if(!payload||!Array.isArray(payload.items))throw Error('FORMATO_CATALOGO_INVALIDO');
  const items=payload.items.slice(0,10000);
  cached.set(key,{at:Date.now(),items});
  return items;
}
// Solo páginas que existen en conocimiento.json: NO actúa como proxy abierto.
function catalogKey(value) {
  if (typeof value!=='string'||value.length>500)return null;
  try {
    const u=new URL(value);
    if (u.protocol!=='https:'||u.hostname!=='appinitdev.com'||u.port||u.username||u.password||u.search||u.hash)return null;
    const p=u.pathname.replace(/\/$/,'')||'/';
    if (/\.(?:json|xml|pdf|zip|js|css|png|jpg|mp4)$/i.test(p))return null;
    return u.origin+p;
  } catch{return null;}
}
function unescapeText(s) {
  const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',copy:'©'};
  return s.replace(/&(#(?:x[0-9a-fA-F]+|\d+)|[a-zA-Z]+);/g,(full,k)=>{
    if(k.startsWith('#')) {const n=k[1]?.toLowerCase()==='x'?parseInt(k.slice(2),16):parseInt(k.slice(1),10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):full;}
    return named[k.toLowerCase()]??full;
  });
}
function htmlText(html) {
  let t=html.replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<(header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/article|\/section|\/pre)\b[^>]*>/gi,'\n')
    .replace(/<[^>]+>/g,' ');
  return unescapeText(t).replace(/[\t ]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
async function readLimitedHtml(url) {
  // No se permiten redirecciones a dominios externos. 400 KB límite de lectura.
  for(let hops=0;hops<3;hops++) {
    if (!catalogKey(url))throw Error('REDIRECCION_EXTERNA');
    const res=await fetch(url,{headers:{Accept:'text/html'},redirect:'manual',signal:AbortSignal.timeout(8500)});
    if([301,302,303,307,308].includes(res.status)) {
      const target=res.headers.get('Location');if(!target)throw Error('REDIRECCION_SIN_DESTINO');
      url=new URL(target,url).href;continue;
    }
    if(!res.ok)throw Error('HTML_HTTP_'+res.status);
    const type=res.headers.get('Content-Type')||'';
    if(!/text\/html/i.test(type))throw Error('NO_ES_HTML');
    if(Number(res.headers.get('Content-Length')||0)>400000)throw Error('HTML_DEMASIADO_GRANDE');
    let size=0;const chunks=[];
    if(!res.body)throw Error('RESPUESTA_SIN_CUERPO');
    const reader=res.body.getReader();
    try {
      while(true) {
        const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;
        if(size>400000){await reader.cancel();throw Error('HTML_DEMASIADO_GRANDE');}
        chunks.push(value);
      }
    } finally {try{reader.releaseLock();}catch{}}
    const bytes=new Uint8Array(size);let pos=0;for(const c of chunks){bytes.set(c,pos);pos+=c.length;}
    const html=new TextDecoder('utf-8').decode(bytes);
    if(/<meta\s+[^>]*name\s*=\s*["']?(?:robots|googlebot)["']?[^>]*content\s*=\s*["']?[^>]*noindex/i.test(html))throw Error('NOINDEX');
    return htmlText(html);
  }
  throw Error('DEMASIADAS_REDIRECCIONES');
}

// Índice invertido V1.5: solo se descargan los archivos que corresponden a términos consultados.
// El JSON se genera localmente, de modo que Cloudflare Workers Free no indexa 2,000 HTML en cada petición.
const SEARCH_CACHE=new Map();
const SEARCH_STOP=new Set('a al algo algunas algunos ante antes como con contra cual cuando de del desde donde dos el ella ellas ellos en entre era es esa ese eso esta estas este estos fue han hasta hay la las le les lo los mas más mi mis muy no nos o para pero por porque que quien quienes se sea ser si sin sobre su sus te tu tus un una uno unos unas y ya are as at be by for from has have in into is it of on or the this to was were what when where who with and their not'.split(' '));
function tokenizeQuery(text){
  const cleaned=norm(text).match(/[a-z0-9]{3,}/g)||[];
  return [...new Set(cleaned.filter(t=>!SEARCH_STOP.has(t)))].slice(0,6);
}
function searchBucket(term){let n=0;for(const c of term)n=(n*31+c.charCodeAt(0))%32;return n;}
async function searchJson(path){
  if(!/^(?:manifest|documentos|temas|terminos-\d{2}|fragmentos-\d{2})\.json$/.test(path))throw Error('RUTA_INDICE_INVALIDA');
  const cachedItem=SEARCH_CACHE.get(path);
  if(cachedItem&&Date.now()-cachedItem.at<120000)return cachedItem.data;
  const response=await fetch(DATA_ORIGIN+'busqueda/'+path,{headers:{Accept:'application/json'},cf:{cacheEverything:true,cacheTtl:120},signal:AbortSignal.timeout(6500)});
  if(!response.ok)throw Error('INDICE_V15_NO_DISPONIBLE');
  const data=await response.json();
  SEARCH_CACHE.set(path,{at:Date.now(),data});
  return data;
}
async function fulltextSearch(args){
  if(!isString(args.consulta,160))throw Error('Consulta requerida (1-160 caracteres).');
  const terms=tokenizeQuery(args.consulta);
  if(!terms.length)return {consulta:args.consulta,resultados:[],total:0,nota:'Usa palabras significativas de tres o más caracteres.'};
  const l=args.limite===undefined?5:args.limite;
  if(!Number.isInteger(l)||l<1||l>10)throw Error('limite debe estar entre 1 y 10.');
  if(args.tema!==undefined&&(typeof args.tema!=='string'||args.tema.length>70))throw Error('Tema no válido.');
  if(args.solo_html!==undefined&&typeof args.solo_html!=='boolean')throw Error('solo_html debe ser booleano.');
  const [index,manifest,...buckets]=await Promise.all([
    searchJson('documentos.json'),searchJson('manifest.json'),
    ...[...new Set(terms.map(searchBucket))].map(x=>searchJson('terminos-'+String(x).padStart(2,'0')+'.json'))
  ]);
  if(!Array.isArray(index.items))throw Error('FORMATO_INDICE_INVALIDO');
  const bmap=new Map([...new Set(terms.map(searchBucket))].map((b,i)=>[b,buckets[i]]));
  const scores=new Map();
  for(const term of terms){
    const posting=bmap.get(searchBucket(term))?.[term]||[];
    const idf=1+Math.log(1+(index.items.length+1)/(posting.length+1));
    for(const record of posting){
      const [id,tf,chunk]=record;
      if(!Number.isInteger(id)||id<0||id>=index.items.length)continue;
      const cur=scores.get(id)||{score:0,matched:0,chunkScores:new Map()};
      const weight=Math.min(12,Math.log2(1+tf))*idf;
      cur.score+=weight;cur.matched+=1;
      cur.chunkScores.set(chunk,(cur.chunkScores.get(chunk)||0)+weight);
      scores.set(id,cur);
    }
  }
  let matches=[...scores].filter(([id])=>{
    const d=index.items[id];if(!d)return false;
    return (!args.tema||d.temas?.includes(args.tema))&&(!args.solo_html||d.texto_completo_indexado===true);
  });
  const phrase=norm(args.consulta.trim());
  const boost=([id,s])=>s.matched*10+s.score+(norm(index.items[id].titulo).includes(phrase)?25:0);
  matches.sort((a,b)=>boost(b)-boost(a));
  const ranked=matches.slice(0,l);
  const needed=[...new Set(ranked.map(([id])=>id%32))];
  const groups=await Promise.all(needed.map(b=>searchJson('fragmentos-'+String(b).padStart(2,'0')+'.json')));
  const groupMap=new Map(needed.map((b,i)=>[b,groups[i]]));
  const resultados=ranked.map(([id,score])=>{
    const d=index.items[id];
    const ch=[...score.chunkScores].sort((a,b)=>b[1]-a[1])[0]?.[0]??0;
    const excerpts=groupMap.get(id%32)?.[String(id)]||[];
    return {titulo:d.titulo,url:d.url,descripcion:d.descripcion,temas:d.temas,
      coincidencias:score.matched,fragmento:excerpts[ch]||d.extracto||'',
      texto_completo_indexado:d.texto_completo_indexado,procedencia_texto:d.procedencia_texto||'solo_metadatos',
      estado_fuente:d.texto_completo_indexado?'HTML analizado, confirmar artículo original':'solo metadatos o extracto disponible'};
  });
  return {consulta:args.consulta,terminos:terms,total_coincidencias:matches.length,mostrados:resultados.length,
    cobertura:{paginas:index.items.length,con_html_completo:manifest.documentos_con_html_local_completo},
    nota:'Índice textual local. Los resultados con solo metadatos no equivalen a la lectura íntegra del artículo.',resultados};
}
function recordMetric(env,name,success,elapsed,count=0){
  // Nunca se registran consultas, direcciones IP, URLs de artículos, identificadores ni datos de usuarios.
  const when=new Date().toISOString();
  const event={tipo:'APPINITDEV_MCP_METRIC',fecha_utc:when,herramienta:name,estado:success?'ok':'error',duracion_ms:Math.round(elapsed),resultados:count};
  console.log(JSON.stringify(event));
  try {
    env.MCP_METRICS?.writeDataPoint?.({blobs:[name,success?'ok':'error',when.slice(0,10)],doubles:[Math.round(elapsed),count],indexes:['appinitdev-mcp']});
  } catch { /* Métricas nunca deben interrumpir las consultas. */ }
}


const REPORT_CACHE=new Map();
async function readPublicSummary(name){
  if(name!=='calidad/resumen.json')throw Error('RUTA_DE_REPORTE_INVALIDA');
  const old=REPORT_CACHE.get(name);if(old&&Date.now()-old.at<120000)return old.obj;
  const r=await fetch(DATA_ORIGIN+name,{headers:{Accept:'application/json'},cf:{cacheEverything:true,cacheTtl:120},signal:AbortSignal.timeout(6000)});
  if(!r.ok)throw Error('INFORME_NO_DISPONIBLE');
  const obj=await r.json();REPORT_CACHE.set(name,{at:Date.now(),obj});return obj;
}

const PUBLIC_IDENTITY_CACHE = new Map();
async function readIdentity(){
  const old=PUBLIC_IDENTITY_CACHE.get('identity');
  if(old&&Date.now()-old.at<120000)return old.data;
  const resp=await fetch(DATA_ORIGIN+'identidad.json',{headers:{Accept:'application/json'},cf:{cacheEverything:true,cacheTtl:120},signal:AbortSignal.timeout(6000)});
  if(!resp.ok)throw Error('IDENTIDAD_PUBLICA_NO_DISPONIBLE');
  const data=await resp.json();
  if(!data||typeof data!=='object'||typeof data.organizacion?.nombre!=='string'||!Array.isArray(data.aplicaciones))throw Error('IDENTIDAD_PUBLICA_INVALIDA');
  PUBLIC_IDENTITY_CACHE.set('identity',{at:Date.now(),data});
  return data;
}

async function obtenerIconoApp(identificador) {
  const apps = await readData('apps');

  const app = apps.find(a =>
    a.id === identificador ||
    a.slug === identificador
  );

  if (!app || !app.icono) {
    throw Error('ICONO_NO_DISPONIBLE');
  }

  const url = new URL(app.icono);

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'appinitdev.com' ||
    !url.pathname.startsWith('/imagen_apps/') ||
    !url.pathname.endsWith('.png')
  ) {
    throw Error('URL_ICONO_INVALIDA');
  }

  
  const response = await fetch(url.href, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000)
  });

  if (response.status >= 300 && response.status < 400) {
    throw Error('REDIRECCION_ICONO_NO_PERMITIDA');
  }


  if (!response.ok) {
    throw Error('ERROR_DESCARGA_ICONO');
  }

  if (!/^image\/png(?:;|$)/i.test(
    response.headers.get('Content-Type') || ''
  )) {
    throw Error('FORMATO_ICONO_INVALIDO');
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.length > 1024 * 1024) {
    throw Error('ICONO_DEMASIADO_GRANDE');
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          nombre: app.nombre,
          icono_oficial: url.href,
          fuente: 'AppInitDev'
        })
      },
      {
        type: 'image',
        data: btoa(binary),
        mimeType: 'image/png'
      }
    ]
  };
}

async function callTool(name,args) {
  if(!args||typeof args!=='object'||Array.isArray(args))args={};
  const requireQuery=()=>{if(!isString(args.consulta))throw Error('Se requiere consulta (1-120 caracteres).'); const l=limit(args.limite);if(l===null)throw Error('limite debe ser entero entre 1 y 20.');return l;};
  switch(name){
    case 'obtener_identidad': {
      const ident=await readIdentity();
      return textResult({organizacion:ident.organizacion,desarrollador:ident.desarrollador,google_play:ident.google_play,redes_sociales:ident.redes_sociales_declaradas,numero_de_apps:ident.aplicaciones.length,fuente:'datos/identidad.json',advertencia:'Identidad declarada por AppInitDev. No hay acceso a Google Play Console ni verificación en vivo de redes.'});
    }
    case 'listar_redes_sociales': {
      const ident=await readIdentity();
      return textResult({redes_sociales:ident.redes_sociales_declaradas,perfiles_personales:ident.desarrollador?.perfiles_personales_declarados||[],fuente:'index.html (JSON-LD sameAs)',verificacion:'declaradas_en_web; cuentas no verificadas externamente'});
    }

    case 'obtener_icono_app': {
      if (!isString(args.identificador, 130)) {
        throw Error('IDENTIFICADOR_INVALIDO');
      }

      return await obtenerIconoApp(args.identificador);
    }
    
    case 'listar_apps_desarrollador': {
      const n = args.limite === undefined ? 100 : args.limite;

      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw Error('limite debe ser entero entre 1 y 100.');
      }

      // Obtener identidad y catálogo oficial con iconos.
      const [ident, apps] = await Promise.all([
        readIdentity(),
        readData('apps')
      ]);

      // Relacionar aplicaciones mediante su paquete Android.
      const iconosPorPaquete = new Map(
        apps.map(app => [app.id, app.icono || null])
      );

      // Agregar el icono oficial a cada aplicación.
      const aplicaciones = ident.aplicaciones
        .slice(0, n)
        .map(app => ({
          ...app,
          icono: iconosPorPaquete.get(app.paquete) || null
        }));

      return textResult({
        desarrollador: ident.organizacion.nombre,
        perfil_google_play:
          ident.google_play?.perfil_desarrollador || null,
        total: ident.aplicaciones.length,
        aplicaciones,
        fuente_iconos: 'https://appinitdev.com/datos/apps.json',
        nota: 'Los iconos son URLs oficiales declaradas por AppInitDev. No sustituir por imagenes de aplicaciones de terceros. La disponibilidad en Google Play no se verifica en tiempo real.'
      });
    }
    case 'explorar_relaciones': {
      const query=String(args.consulta||args.paquete||'').trim();
      if(query.length>150)throw Error('Consulta demasiado larga.');
      const n=args.limite??5;if(!Number.isInteger(n)||n<1||n>10)throw Error('limite debe ser entero entre 1 y 10.');
      const [graph,summary]=await Promise.all([readExtra('relaciones/apps.json'),readExtra('relaciones/resumen.json')]);
      const rows=graph.items.filter(a=>!query||[a.paquete,a.nombre,a.slug].some(s=>contains(s,query))).slice(0,n);
      return textResult({resultados:rows,resumen:summary,nota:'Relaciones app-artículo inferidas por slug visible en ruta; no prueba que la app implemente todas las funciones del artículo.'});
    }
    case 'consultar_idiomas':return textResult(await readExtra('idiomas/resumen.json'));
    case 'estado_play_store':return textResult(await readExtra('play-store/resumen.json'));
    case 'resumen_impacto_ia':return textResult(await readExtra('impacto/resumen.json'));
    case 'evaluar_reconocimiento':return textResult(await readExtra('reconocimiento/resumen.json'));
    case 'buscar_texto_completo': return textResult(await fulltextSearch(args));
    case 'auditoria_conocimiento':return textResult(await readPublicSummary('calidad/resumen.json'));
    case 'estado_indice':return textResult(await searchJson('manifest.json'));
    case 'listar_temas': {
      const [temas,manifest]=await Promise.all([searchJson('temas.json'),searchJson('manifest.json')]);
      return textResult({temas:temas.items,cobertura:manifest,nota:temas.advertencia});
    }
    case 'buscar_apps': {
      const l=requireQuery(); const apps=await readData('apps');
      const resultados=apps.filter(a=>['nombre','resumen','categoria','slug','id'].some(k=>contains(a[k],args.consulta.trim()))).slice(0,l);
      return textResult({origen:'AppInitDev',resultados});
    }
    case 'obtener_app': {
      if(!isString(args.identificador,130))throw Error('Se requiere identificador válido.');
      const apps=await readData('apps');
      return textResult(apps.find(a=>a.id===args.identificador||a.slug===args.identificador)||{encontrada:false});
    }
    case 'buscar_conocimiento': {
      const l=requireQuery(); const docs=await readData('conocimiento');
      return textResult({origen:'AppInitDev',resultados:docs.filter(d=>['titulo','descripcion','seccion','contenido_extracto'].some(k=>contains(d[k],args.consulta.trim()))).slice(0,l)});
    }
    case 'obtener_articulo': {
      const key=catalogKey(args.url);
      if(!key)throw Error('URL_INVALIDA: solo URLs HTTPS canónicas de appinitdev.com.');
      const n=args.max_caracteres??12000;
      if(!Number.isInteger(n)||n<500||n>16000)throw Error('max_caracteres debe estar entre 500 y 16000.');
      const docs=await readData('conocimiento');
      const doc=docs.find(d=>catalogKey(d.url)===key);
      if(!doc)throw Error('La URL no se encuentra en conocimiento.json.');
      try {
        const full=await readLimitedHtml(doc.url);
        if(!full)throw Error('HTML_SIN_TEXTO');
        return textResult({titulo:doc.titulo,url:doc.url,metodo:'lectura_html_publico',texto:full.slice(0,n),truncado:full.length>n,nota:'Texto extraído de HTML, puede omitir elementos dinámicos; verifica siempre la página original.'});
      } catch(e) {
        const snippet=String(doc.contenido_extracto||'').trim();
        return textResult({titulo:doc.titulo,url:doc.url,metodo:snippet?'extracto_catalogo':'sin_texto_disponible',texto:snippet.slice(0,n),truncado:false,contenido_parcial:true,nota:'No se pudo recuperar el HTML completo desde la fuente pública. Este resultado NO representa una lectura completa.',codigo:String(e.message).slice(0,70)});
      }
    }
    case 'listar_secciones': {
      const cat=args.categoria??'todas'; if(!['todas','apps','articulos','herramientas'].includes(cat))throw Error('categoria desconocida.');
      return textResult({resultados:(await readData('secciones')).filter(s=>cat==='todas'||s.categoria===cat)});
    }
    case 'comparar_apps': {
      if(!Array.isArray(args.identificadores)||args.identificadores.length<2||args.identificadores.length>5||!args.identificadores.every(x=>isString(x,130)))throw Error('Identificadores: entre 2 y 5 slugs o paquetes.');
      const apps=await readData('apps');
      return textResult({resultados:args.identificadores.map(id=>apps.find(a=>a.id===id||a.slug===id)||{identificador:id,encontrada:false})});
    }
    case 'resumen_catalogo': {
      const [apps,conocimiento,secciones]=await Promise.all([readData('apps'),readData('conocimiento'),readData('secciones')]);
      return textResult({aplicaciones:apps.length,documentos:conocimiento.length,secciones:secciones.length,fuente:'JSON público de AppInitDev; no verifica datos de Google Play en vivo'});
    }
    default: return null;
  }
}
async function handle(request,env={}){
    const url=new URL(request.url);
    const origin=request.headers.get('Origin');
    if(origin&&!isAllowedOrigin(origin,env))return json({error:'Origin no permitido'},403);
    if(url.pathname==='/health'&&request.method==='GET')return json({status:'ok',servicio:'appinitdev-mcp-cloudflare',version:RELEASE,solo_lectura:true,protocolo:PRIMARY_VERSION,compatibilidad:VERSIONS,fuente:DATA_ORIGIN});
    if(url.pathname==='/')return json({servicio:'AppInitDev MCP',endpoint:'/mcp',salud:'/health'});
    if(url.pathname!=='/mcp')return json({error:'No encontrado'},404);
    if(request.method==='OPTIONS'){
      return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin||'https://appinitdev.com','Access-Control-Allow-Headers':'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'}});
    }
    if(request.method!=='POST')return json({error:'MCP requiere POST (Streamable HTTP sin GET SSE).'},405,{Allow:'POST, OPTIONS'});
    if(overLimit(request))return json({error:'Demasiadas solicitudes en esta instancia; reintentar después.'},429,{'Retry-After':'60'});
    const accept=request.headers.get('Accept')||'';
    if(!accept.includes('application/json')||!accept.includes('text/event-stream'))return rpcError(null,-32600,'Accept debe incluir application/json y text/event-stream',406);
    const contentType=request.headers.get('Content-Type')||'';
    if(!contentType.toLowerCase().includes('application/json'))return rpcError(null,-32600,'Content-Type debe ser application/json',415);
    const size=Number(request.headers.get('Content-Length')||0);
    if(size>32768)return rpcError(null,-32600,'Solicitud demasiado grande',413);
    let payload;
    try {const body=await request.text();if(body.length>32768)return rpcError(null,-32600,'Solicitud demasiado grande',413);payload=JSON.parse(body);} catch{return rpcError(null,-32700,'JSON no válido',400);}
    if(!payload||Array.isArray(payload)||typeof payload!=='object'||payload.jsonrpc!=='2.0'||typeof payload.method!=='string')return rpcError(payload?.id??null,-32600,'Solicitud JSON-RPC no válida',400);
    const id=Object.prototype.hasOwnProperty.call(payload,'id')?payload.id:undefined;
    const headerVersion=request.headers.get('MCP-Protocol-Version');
    if(headerVersion&&!VERSIONS.includes(headerVersion))return json({jsonrpc:'2.0',id:id??null,error:{code:-32022,message:'Unsupported protocol version',data:{supported:VERSIONS,requested:headerVersion}}},400);
    const modern=headerVersion==='2026-07-28';
    if(modern){
      const meta=payload.params?._meta||{};
      const name=payload.params?.name;
      const rawHeader=request.headers.get('Mcp-Name');
      const decoded=rawHeader?.startsWith('=?base64?')&&rawHeader.endsWith('?=')?decodeMcpHeader(rawHeader):rawHeader;
      if(meta['io.modelcontextprotocol/protocolVersion']!==headerVersion||
         !meta['io.modelcontextprotocol/clientCapabilities']||typeof meta['io.modelcontextprotocol/clientCapabilities']!=='object'||
         request.headers.get('Mcp-Method')!==payload.method||
         (payload.method==='tools/call'&&decoded!==name))return rpcError(id??null,-32020,'HeaderMismatch o metadatos requeridos ausentes',400);
    }
    if(id===undefined)return new Response(null,{status:202});
    if(modern&&payload.method==='server/discover')return rpcResult(id,{supportedVersions:VERSIONS,capabilities:{tools:{listChanged:false},resources:{},prompts:{}},instructions:'Herramientas públicas de solo lectura de AppInitDev. Los datos se consultan desde los catálogos publicados; verificar fuentes originales.',ttlMs:300000,cacheScope:'public'},true);
    if(payload.method==='initialize'&&!modern) {
      const desired=payload.params?.protocolVersion;
      return rpcResult(id,{protocolVersion:VERSIONS.includes(desired)?desired:PRIMARY_VERSION,capabilities:{tools:{listChanged:false},resources:{},prompts:{}},serverInfo:{name:'appinitdev-mcp-cloudflare',version:RELEASE},instructions:'Fuente pública de AppInitDev; consultar herramientas solo lectura. No verificar en vivo Google Play.'});
    }
    if(payload.method==='ping'&&!modern)return rpcResult(id,{});
    if(payload.method==='resources/list')return rpcResult(id,modern?{resources:RESOURCES.map(({source,...r})=>r),ttlMs:300000,cacheScope:'public'}:{resources:RESOURCES.map(({source,...r})=>r)},modern);
    if(payload.method==='resources/read'){
      const uri=payload.params?.uri;const entry=RESOURCES.find(r=>r.uri===uri);
      if(!entry)return rpcError(id,-32602,'URI de recurso desconocida');
      try {
        const value=entry.source==='identidad'?await readIdentity():entry.source==='calidad'?await readPublicSummary('calidad/resumen.json'):await readExtra(entry.source);
        const contents=[{uri:entry.uri,mimeType:'application/json',text:JSON.stringify(value)}];
        return rpcResult(id,modern?{contents,ttlMs:120000,cacheScope:'public'}:{contents},modern);
      }catch{return rpcError(id,-32603,'El recurso todavía no está publicado');}
    }
    if(payload.method==='prompts/list')return rpcResult(id,modern?{prompts:PROMPTS,ttlMs:300000,cacheScope:'public'}:{prompts:PROMPTS},modern);
    if(payload.method==='prompts/get'){
      try{const result=promptGet(payload.params?.name,payload.params?.arguments||{});
        if(!result)return rpcError(id,-32602,'Prompt desconocido');
        return rpcResult(id,result,modern);
      }catch{return rpcError(id,-32602,'Argumentos de prompt no válidos');}
    }
    if(payload.method==='tools/list')return rpcResult(id,modern?{tools,ttlMs:300000,cacheScope:'public'}:{tools},modern);
    if(payload.method==='tools/call'){
      const name=payload.params?.name;
      if(typeof name!=='string')return rpcError(id,-32602,'Nombre de herramienta requerido');
      if(!tools.some(t=>t.name===name))return rpcError(id,-32602,'Herramienta desconocida');
      const started=Date.now();
      try {
        const output=await callTool(name,payload.params?.arguments??{});
        let count=0;try{const data=JSON.parse(output.content?.[0]?.text||'{}');count=Array.isArray(data.resultados)?data.resultados.length:0;}catch{}
        recordMetric(env,name,true,Date.now()-started,count);
        if(modern){try{output.structuredContent=JSON.parse(output.content[0].text)}catch{}}
        return rpcResult(id,output,modern);
      }
      catch(e){
        recordMetric(env,name,false,Date.now()-started);
        console.error("MCP_ERROR_DIAGNOSTICO", {
          herramienta: name,
          codigo: String(e.message),
          detalle: String(e.stack || "").slice(0, 1000)
        });
        if(String(e.message)==='INDICE_V15_NO_DISPONIBLE')return rpcResult(id,{isError:true,content:[{type:'text',text:'Índice V2.0 no publicado: sube /datos/busqueda/ a Hostinger y comprueba manifest.json.'}]},modern);const friendly=['Se requiere','limite debe','categoria desconocida','Identificadores:'].some(s=>String(e.message).startsWith(s));
        return rpcResult(id,{isError:true,content:[{type:'text',text:friendly?e.message:'No se pudo consultar el catálogo público. Verifica /datos/ en AppInitDev.'}]},modern);
      }
    }
    return rpcError(id,-32601,'Método MCP no implementado',modern?404:200);
}
function decodeMcpHeader(value){
  try{const b=value.slice(9,-2);return new TextDecoder().decode(Uint8Array.from(atob(b),ch=>ch.charCodeAt(0)));}catch{return null;}
}
function isAllowedOrigin(origin,env={}) {
  const extra=String(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  return ALLOWED_ORIGINS.has(origin)||extra.includes(origin);
}
export default {
  async fetch(request,env={}) {
    const response=await handle(request,env);
    const origin=request.headers.get('Origin');
    if (!origin||!isAllowedOrigin(origin,env))return response;
    const headers=new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin',origin);
    headers.set('Access-Control-Allow-Methods','POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers','Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name');
    headers.set('Vary','Origin');
    return new Response(response.body,{status:response.status,headers});
  }
};
