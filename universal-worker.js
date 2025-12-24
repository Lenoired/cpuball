let workerRole = 'unknown';
let js_scene = null;
var Module = null;
var wasmInstance = null;
var wasm_renderTile = null;
var wasm_freeFunc = null;
var wasm_initializeScene = null;
function getHeapU8(mod) { if (!mod) { if (typeof HEAPU8 !== 'undefined') return HEAPU8; return null; } if (mod.HEAPU8) return mod.HEAPU8; if (mod.asm && mod.asm.HEAPU8) return mod.asm.HEAPU8; if (typeof HEAPU8 !== 'undefined') return HEAPU8; return null; }
function onWasmModuleReady(m) {
    wasmInstance = m || Module;
    try { if (typeof wasmInstance.cwrap !== 'function') { if (typeof Module !== 'undefined' && typeof Module.cwrap === 'function') wasmInstance = Module; } } catch (err) { console.error('cwrap lookup error', err); }
    if (!wasmInstance || typeof wasmInstance.cwrap !== 'function') { self.postMessage({ type: 'error', error: 'cwrap not found on module' }); return; }
    
    wasm_initializeScene = wasmInstance.cwrap('initialize_scene', null, []);
    wasm_freeFunc = wasmInstance.cwrap('free_memory', null, ['number']);

 
    if (isLegacyScene) {
        
        console.log('Wrapping legacy render_tile function.');
        wasm_renderTile_legacy = wasmInstance.cwrap('render_tile', 'number', ['number', 'number', 'number', 'number', 'number', 'string', 'number', 'number', 'boolean']);
    } else {
      
        console.log('Wrapping modern render_tile function.');
        // MODIFICATION: Added 'number' at the end of the array for challengeSeed
        wasm_renderTile_modern = wasmInstance.cwrap('render_tile', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'boolean', 'number', 'number', 'number']);
    }
    
    self.postMessage({ type: 'ready' });
}
function initializeWasm(data) {
	isLegacyScene = data.isLegacy;
    Module = {
        wasmModule: data.wasmModule,
        onRuntimeInitialized: function() { try { onWasmModuleReady(Module); } catch (err) { console.error('onRuntimeInitialized error', err); } }
    };
    try {
        importScripts(data.jsUrl);
    } catch (err) {
        self.postMessage({ type: 'error', error: 'importScripts failed for ' + data.jsUrl });
        return;
    }
   
    try {
        if (typeof createModule === 'function') {
            const maybePromise = createModule(Module);
            if (maybePromise && typeof maybePromise.then === 'function') {
                maybePromise.then(m => onWasmModuleReady(m)).catch(err => { self.postMessage({ type: 'error', error: 'createModule rejected' }); });
            } else { onWasmModuleReady(maybePromise || Module); }
        }
    } catch (err) { console.warn('factory invocation attempt failed', err); }
}
function renderWasmTile(data) {
    // ADD challengeSeed HERE vvv
const { tile, canvasWidth, canvasHeight, samplesPerPixel, maxDepth, useDenoiser, debugMode, noiseThreshold, challengeSeed } = data;
    let pixelDataPtr = 0;
    
    try {
        if (isLegacyScene) {
            
            if (!wasm_renderTile_legacy) { self.postMessage({type: 'error', error: 'Legacy WASM renderer not ready'}); return; }
        
            pixelDataPtr = wasm_renderTile_legacy(tile.x, tile.y, tile.size, canvasWidth, canvasHeight, "", samplesPerPixel, maxDepth, useDenoiser);
        } else {
          
            if (!wasm_renderTile_modern) { self.postMessage({type: 'error', error: 'Modern WASM renderer not ready'}); return; }
            pixelDataPtr = wasm_renderTile_modern(
    tile.x, 
    tile.y, 
    tile.size, 
    canvasWidth, 
    canvasHeight, 
    samplesPerPixel, 
    maxDepth, 
    useDenoiser, 
    debugMode, 
    noiseThreshold,
    challengeSeed // <--- ADD THIS
);
        }
    } catch (err) { 
        console.error('renderTile call failed', err); 
        self.postMessage({type: 'error', error: 'WASM render_tile execution failed. ' + err});
        return; 
    }
    if (!pixelDataPtr) { console.error('renderTile returned null/0 pointer'); return; }
    const heap = getHeapU8(wasmInstance);
    if (!heap || !heap.buffer) { console.error('HEAPU8 not available after render'); return; }
    const byteLength = tile.size * tile.size * 4;
    const view = new Uint8ClampedArray(heap.buffer, pixelDataPtr, byteLength);
    const copied = new Uint8ClampedArray(byteLength);
    copied.set(view);
    if (wasm_freeFunc) { try { wasm_freeFunc(pixelDataPtr); } catch (err) { console.warn('free attempt failed', err); } }
    try { self.postMessage({ type: 'result', pixelData: copied, tile }, [copied.buffer]); } catch (err) { self.postMessage({ type: 'result', pixelData: copied.slice(), tile }, []); }
}
const V = {
    create: (x = 0, y = 0, z = 0, out = {}) => { out.x = x; out.y = y; out.z = z; return out; },
    add: (v1, v2, out) => { out.x = v1.x + v2.x; out.y = v1.y + v2.y; out.z = v1.z + v2.z; return out; },
    subtract: (v1, v2, out) => { out.x = v1.x - v2.x; out.y = v1.y - v2.y; out.z = v1.z - v2.z; return out; },
    scale: (v, s, out) => { out.x = v.x * s; out.y = v.y * s; out.z = v.z * s; return out; },
    dot: (v1, v2) => v1.x * v2.x + v1.y * v2.y + v1.z * v2.z,
    lengthSq: (v) => V.dot(v, v),
    length: (v) => Math.sqrt(V.lengthSq(v)),
    normalize: (v, out) => {
        const mSq = V.lengthSq(v);
        if (mSq > 1e-16) {
            const invM = 1.0 / Math.sqrt(mSq);
            V.scale(v, invM, out);
        } else {
            out.x = out.y = out.z = 0;
        }
        return out;
    },
    reflect: (v, normal, out) => {
        const dot = 2 * V.dot(v, normal);
        out.x = v.x - dot * normal.x;
        out.y = v.y - dot * normal.y;
        out.z = v.z - dot * normal.z;
        return out;
    },
    cross: (v1, v2, out) => {
        out.x = v1.y * v2.z - v1.z * v2.y;
        out.y = v1.z * v2.x - v1.x * v2.z;
        out.z = v1.x * v2.y - v1.y * v2.x;
        return out;
    }
};
const C = {
    create: (r = 0, g = 0, b = 0, out = {}) => { out.r = r; out.g = g; out.b = b; return out; },
    add: (c1, c2, out) => { out.r = c1.r + c2.r; out.g = c1.g + c2.g; out.b = c1.b + c2.b; return out; },
    scale: (c, s, out) => { out.r = c.r * s; out.g = c.g * s; out.b = c.b * s; return out; },
    multiply: (c1, c2, out) => { out.r = c1.r * c2.r; out.g = c1.g * c2.g; out.b = c1.b * c2.b; return out; },
    max: (c) => Math.max(c.r, Math.max(c.g, c.b)),
    luminance: (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
};
const U64_MASK = (1n << 64n) - 1n;
const MUL = 6364136223846793005n;
let pcgState = { state: 0n, inc: 0n };
function resetPrngForTile(x, y, width, seed = 0) {
    pcgState.state = BigInt(y * width + x + 1) + BigInt(seed);
    pcgState.inc = BigInt((y * width + x) * 2 + 1) + BigInt(seed);
}
function pcg32Random() {
    let oldstate = pcgState.state;
    pcgState.state = ((oldstate * MUL) + (pcgState.inc | 1n)) & U64_MASK;
    let xorshifted = Number((((oldstate >> 18n) ^ oldstate) >> 27n) & 0xffffffffn);
    let rot = Number((oldstate >> 59n) & 31n);
    return (xorshifted >>> rot) | (xorshifted << ((-rot) & 31));
}
function randomDouble() {
    return pcg32Random() / 4294967296.0;
}
function randomInUnitSphere(out) {
    while (true) {
        out.x = randomDouble() * 2 - 1;
        out.y = randomDouble() * 2 - 1;
        out.z = randomDouble() * 2 - 1;
        if (V.lengthSq(out) < 1) return out;
    }
}
function randomInUnitDisk(out) {
    while (true) {
        out.x = randomDouble() * 2 - 1;
        out.y = randomDouble() * 2 - 1;
        out.z = 0;
        if (V.lengthSq(out) < 1) return out;
    }
}
const rcdScratch1 = V.create(), rcdScratch2 = V.create(), rcdScratch3 = V.create(), rcdScratch4 = V.create();
function randomCosineDirection(normal, out) {
    const r1 = randomDouble();
    const r2 = randomDouble();
    const z = Math.sqrt(1 - r2);
    const phi = 2 * Math.PI * r1;
    const x = Math.cos(phi) * Math.sqrt(r2);
    const y = Math.sin(phi) * Math.sqrt(r2);
    const up = Math.abs(normal.z) < 0.999 ? V.create(0,0,1, rcdScratch1) : V.create(1,0,0, rcdScratch1);
    V.normalize(V.cross(up, normal, rcdScratch2), rcdScratch2);
    V.cross(normal, rcdScratch2, rcdScratch3);
    V.scale(rcdScratch2, x, rcdScratch2);
    V.scale(rcdScratch3, y, rcdScratch3);
    V.scale(normal, z, rcdScratch4);
    V.add(rcdScratch2, rcdScratch3, out);
    V.add(out, rcdScratch4, out);
    V.normalize(out, out);
    return out;
}
class AABB {
    constructor(min = V.create(), max = V.create()) {
        this.min = min;
        this.max = max;
    }
    intersect(ray, tMin, tMax) {
        let t_min = tMin, t_max = tMax;
        for (let a = 0; a < 3; a++) {
            const invD = 1.0 / [ray.direction.x, ray.direction.y, ray.direction.z][a];
            let t0 = ([this.min.x, this.min.y, this.min.z][a] - [ray.origin.x, ray.origin.y, ray.origin.z][a]) * invD;
            let t1 = ([this.max.x, this.max.y, this.max.z][a] - [ray.origin.x, ray.origin.y, ray.origin.z][a]) * invD;
            if (invD < 0.0) [t0, t1] = [t1, t0];
            t_min = t0 > t_min ? t0 : t_min;
            t_max = t1 < t_max ? t1 : t_max;
            if (t_max <= t_min) return false;
        }
        return true;
    }
}
function surroundingBox(box0, box1, out = new AABB()) {
    V.create(Math.min(box0.min.x, box1.min.x), Math.min(box0.min.y, box1.min.y), Math.min(box0.min.z, box1.min.z), out.min);
    V.create(Math.max(box0.max.x, box1.max.x), Math.max(box0.max.y, box1.max.y), Math.max(box0.max.z, box1.max.z), out.max);
    return out;
}
function surfaceArea(box) {
    const extent = V.create();
    V.subtract(box.max, box.min, extent);
    return 2.0 * (extent.x * extent.y + extent.x * extent.z + extent.y * extent.z);
}
class Material {
    constructor(albedo = C.create(1,1,1), emissive = C.create(0,0,0), metalness = 0.0, roughness = 0.0, ior = 1.5, transparency = 0.0) {
        this.albedo = albedo; this.emissive = emissive; this.metalness = metalness;
        this.roughness = roughness; this.ior = ior; this.transparency = transparency;
    }
}
class HitRecord {
    constructor() {
        this.dist = Infinity; this.point = V.create(); this.normal = V.create();
        this.frontFace = false; this.material = null;
    }
    setFaceNormal(ray, outwardNormal) {
        this.frontFace = V.dot(ray.direction, outwardNormal) < 0;
        V.scale(outwardNormal, this.frontFace ? 1 : -1, this.normal);
    }
    reset() { this.dist = Infinity; this.material = null; }
}
const globalHitRec = new HitRecord();
class Hittable {
    intersect(ray, tMin, tMax, rec) { return false; }
    boundingBox(out = new AABB()) { return out; }
}
class Sphere extends Hittable {
    constructor(center, radius, material) {
        super(); this.center = center; this.radius = radius; this.material = material;
    }
    intersect(ray, tMin, tMax, rec) {
        const oc = V.create();
        V.subtract(ray.origin, this.center, oc);
        const a = V.lengthSq(ray.direction);
        const halfB = V.dot(oc, ray.direction);
        const c = V.lengthSq(oc) - this.radius * this.radius;
        const discriminant = halfB * halfB - a * c;
        if (discriminant < 0) return false;
        const sqrtd = Math.sqrt(discriminant);
        let root = (-halfB - sqrtd) / a;
        if (root < tMin || tMax < root) {
            root = (-halfB + sqrtd) / a;
            if (root < tMin || tMax < root) return false;
        }
        rec.dist = root;
        V.scale(ray.direction, root, rec.point);
        V.add(ray.origin, rec.point, rec.point);
        const outwardNormal = V.create();
        V.subtract(rec.point, this.center, outwardNormal);
        V.scale(outwardNormal, 1 / this.radius, outwardNormal);
        rec.setFaceNormal(ray, outwardNormal);
        rec.material = this.material;
        return true;
    }
 boundingBox(out = new AABB()) {
        V.create(this.center.x - this.radius, this.center.y - this.radius, this.center.z - this.radius, out.min);
        V.create(this.center.x + this.radius, this.center.y + this.radius, this.center.z + this.radius, out.max);
        return out;
    }
}
class Rect extends Hittable {
    constructor(p0, p1, p2, p3, normal, material) {
        super();
        this.p0 = p0; this.p1 = p1; this.p2 = p2; this.p3 = p3;
        this.normal = V.create(); V.normalize(normal, this.normal); this.material = material;
    }
    intersect(ray, tMin, tMax, rec) {
        const denom = V.dot(this.normal, ray.direction);
        if (Math.abs(denom) > 1e-6) {
            const t = V.dot(V.subtract(this.p0, ray.origin, V.create()), this.normal) / denom;
            if (t > tMin && t < tMax) {
                const hitPoint = V.create();
                V.add(ray.origin, V.scale(ray.direction, t, V.create()), hitPoint);
                const v0 = V.subtract(this.p1, this.p0, V.create());
                const v1 = V.subtract(this.p3, this.p0, V.create());
                const v2 = V.subtract(hitPoint, this.p0, V.create());
                const dot00 = V.dot(v0, v0), dot01 = V.dot(v0, v1), dot02 = V.dot(v0, v2);
                const dot11 = V.dot(v1, v1), dot12 = V.dot(v1, v2);
                const invDenom = 1.0 / (dot00 * dot11 - dot01 * dot01);
                const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
                const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
                if (u >= 0 && v >= 0 && u <= 1 && v <= 1) {
                    rec.dist = t; rec.point.x = hitPoint.x; rec.point.y = hitPoint.y; rec.point.z = hitPoint.z;
                    rec.setFaceNormal(ray, this.normal); rec.material = this.material;
                    return true;
                }
            }
        }
        return false;
    }
    boundingBox(out = new AABB()) {
        const e = 0.0001;
        out.min.x = Math.min(this.p0.x, this.p1.x, this.p2.x, this.p3.x) - e;
        out.min.y = Math.min(this.p0.y, this.p1.y, this.p2.y, this.p3.y) - e;
        out.min.z = Math.min(this.p0.z, this.p1.z, this.p2.z, this.p3.z) - e;
        out.max.x = Math.max(this.p0.x, this.p1.x, this.p2.x, this.p3.x) + e;
        out.max.y = Math.max(this.p0.y, this.p1.y, this.p2.y, this.p3.y) + e;
        out.max.z = Math.max(this.p0.z, this.p1.z, this.p2.z, this.p3.z) + e;
        return out;
    }
}
class BVHNode extends Hittable {
   
    constructor(objects, isLeaf = false) {
        super();
        this.left = null;
        this.right = null;
        this.box = new AABB();
        this.nodeObjects = [];
        this.isLeafNode = isLeaf;
        if (isLeaf) {
            this.nodeObjects = objects;
            if (objects.length > 0) {
                objects[0].boundingBox(this.box);
                const tempBox = new AABB();
                for (let i = 1; i < objects.length; i++) {
                    objects[i].boundingBox(tempBox);
                    surroundingBox(this.box, tempBox, this.box);
                }
            }
            return;
        }
        if (objects.length <= 4) {
            this.isLeafNode = true;
            this.nodeObjects = objects;
        
            const leafNode = new BVHNode(objects, true);
            this.box = leafNode.box;
            return;
        }
        const tempBoxForSortA = new AABB();
        const tempBoxForSortB = new AABB();
      
        let initialBox = objects[0].boundingBox(new AABB());
        for(let i = 1; i < objects.length; i++) {
            surroundingBox(initialBox, objects[i].boundingBox(tempBoxForSortA), initialBox);
        }
        this.box = initialBox;
        const parentSA = surfaceArea(this.box);
        let minCost = Infinity;
        let bestAxis = -1;
        let bestSplit = 0;
        for (let axis = 0; axis < 3; axis++) {
            const key = ['x', 'y', 'z'][axis];
            objects.sort((a, b) => {
                return a.boundingBox(tempBoxForSortA).min[key] - b.boundingBox(tempBoxForSortB).min[key];
            });
            for (let i = 1; i < objects.length; i++) {
                let leftBox = objects[0].boundingBox(new AABB());
                for(let j = 1; j < i; j++) {
                    surroundingBox(leftBox, objects[j].boundingBox(tempBoxForSortA), leftBox);
                }
                let rightBox = objects[i].boundingBox(new AABB());
                for(let j = i + 1; j < objects.length; j++) {
                     surroundingBox(rightBox, objects[j].boundingBox(tempBoxForSortA), rightBox);
                }
                const cost = 0.125 + (i * surfaceArea(leftBox) + (objects.length - i) * surfaceArea(rightBox)) / parentSA;
                if (cost < minCost) {
                    minCost = cost;
                    bestAxis = axis;
                    bestSplit = i;
                }
            }
        }
        if (bestAxis !== -1 && minCost < objects.length) {
             const key = ['x', 'y', 'z'][bestAxis];
             objects.sort((a, b) => {
                return a.boundingBox(tempBoxForSortA).min[key] - b.boundingBox(tempBoxForSortB).min[key];
            });
            this.left = new BVHNode(objects.slice(0, bestSplit));
            this.right = new BVHNode(objects.slice(bestSplit));
            surroundingBox(this.left.box, this.right.box, this.box);
        } else {
            this.isLeafNode = true;
            this.nodeObjects = objects;
            const leafNode = new BVHNode(objects, true);
            this.box = leafNode.box;
        }
    }
    intersect(ray, tMin, tMax, rec) {
        if (!this.box.intersect(ray, tMin, tMax)) return false;
        const nodeStack = [];
        let current = this;
        let hit = false;
        let closest = tMax;
        while (true) {
            if (current.box.intersect(ray, tMin, closest)) {
                if (current.isLeafNode) {
                    for (const obj of current.nodeObjects) {
                        if (obj.intersect(ray, tMin, closest, rec)) {
                            hit = true;
                            closest = rec.dist;
                        }
                    }
                } else {
                    if (current.right) nodeStack.push(current.right);
                    current = current.left;
                    continue;
                }
            }
            if (nodeStack.length === 0) break;
            current = nodeStack.pop();
        }
        return hit;
    }
  
    boundingBox(out = new AABB()) {
        out.min.x = this.box.min.x; out.min.y = this.box.min.y; out.min.z = this.box.min.z;
        out.max.x = this.box.max.x; out.max.y = this.box.max.y; out.max.z = this.box.max.z;
        return out;
    }
}
class Scene {
    constructor() {
        this.camOrigin = V.create(0, 0, -25);
        this.background = C.create(0.058, 0.058, 0.078);
        this.bvhRoot = null; this.lights = [];
    }
}
function reflectance(cosine, refIdx) {
    let r0 = (1 - refIdx) / (1 + refIdx);
    r0 = r0 * r0;
    const base = 1.0 - cosine;
    return r0 + (1.0 - r0) * base * base * base * base * base;
}
class GBuffer {
    constructor() { this.albedo = C.create(); this.normal = V.create(); }
    reset() {
        this.albedo.r = this.albedo.g = this.albedo.b = 0;
        this.normal.x = this.normal.y = this.normal.z = 0;
    }
}
const globalGBuffer = new GBuffer();
const traceScratch = {
    tempV1: V.create(), tempV2: V.create(), tempV3: V.create(), tempV4: V.create(),
    scatterDir: V.create(), unitDir: V.create(), reflected: V.create(),
    rOutPerp: V.create(), rOutParallel: V.create(),
    toLight: V.create(), pointOnLight: V.create(), brdf: C.create(), contrib: C.create(),
    shadowRec: new HitRecord(),
    lightBox: new AABB()
};
function js_trace(ray, scene, maxDepth, gbuffer) {
    const s = traceScratch;
    const accumulatedColor = C.create(0,0,0);
    const attenuation = C.create(1,1,1);
    let isSpecularBounce = true;
    const currentRay = { origin: V.create(ray.origin.x, ray.origin.y, ray.origin.z), direction: V.create(ray.direction.x, ray.direction.y, ray.direction.z) };
    for (let depth = 0; depth < maxDepth; ++depth) {
        globalHitRec.reset();
        if (!scene.bvhRoot.intersect(currentRay, 0.001, Infinity, globalHitRec)) {
            C.multiply(scene.background, attenuation, s.contrib);
            C.add(accumulatedColor, s.contrib, accumulatedColor);
            if (depth === 0) {
                gbuffer.normal.x = gbuffer.normal.y = gbuffer.normal.z = 0;
                gbuffer.albedo.r = scene.background.r; gbuffer.albedo.g = scene.background.g; gbuffer.albedo.b = scene.background.b;
            }
            break;
        }
        if (depth === 0) {
            gbuffer.albedo.r = globalHitRec.material.albedo.r; gbuffer.albedo.g = globalHitRec.material.albedo.g; gbuffer.albedo.b = globalHitRec.material.albedo.b;
            gbuffer.normal.x = globalHitRec.normal.x; gbuffer.normal.y = globalHitRec.normal.y; gbuffer.normal.z = globalHitRec.normal.z;
        }
        if (C.max(globalHitRec.material.emissive) > 0.0) {
            if (isSpecularBounce) {
                C.multiply(globalHitRec.material.emissive, attenuation, s.contrib);
                C.add(accumulatedColor, s.contrib, accumulatedColor);
            }
            break;
        }
        const isSpecular = globalHitRec.material.metalness > 0.0 || globalHitRec.material.transparency > 0.0;
        if (isSpecular) {
            isSpecularBounce = true;
            if (globalHitRec.material.transparency > randomDouble()) {
                const refractionRatio = globalHitRec.frontFace ? (1.0 / globalHitRec.material.ior) : globalHitRec.material.ior;
                V.normalize(currentRay.direction, s.unitDir);
                const cosTheta = Math.min(V.dot(V.scale(s.unitDir, -1, s.tempV1), globalHitRec.normal), 1.0);
                const sinTheta = Math.sqrt(1.0 - cosTheta * cosTheta);
                if (refractionRatio * sinTheta > 1.0 || reflectance(cosTheta, refractionRatio) > randomDouble()) {
                    V.reflect(s.unitDir, globalHitRec.normal, s.scatterDir);
                } else {
                    V.scale(globalHitRec.normal, cosTheta, s.tempV2);
                    V.add(s.unitDir, s.tempV2, s.tempV3);
                    V.scale(s.tempV3, refractionRatio, s.rOutPerp);
                    const parallelLen = Math.sqrt(Math.max(0, 1.0 - V.lengthSq(s.rOutPerp)));
                    V.scale(globalHitRec.normal, -parallelLen, s.rOutParallel);
                    V.add(s.rOutPerp, s.rOutParallel, s.scatterDir);
                }
            } else {
                V.normalize(currentRay.direction, s.unitDir);
                V.reflect(s.unitDir, globalHitRec.normal, s.reflected);
                randomInUnitSphere(s.tempV1);
                V.scale(s.tempV1, globalHitRec.material.roughness, s.tempV1);
                V.add(s.reflected, s.tempV1, s.scatterDir);
                V.normalize(s.scatterDir, s.scatterDir);
                if (V.dot(s.scatterDir, globalHitRec.normal) <= 0) break;
            }
            C.multiply(attenuation, globalHitRec.material.albedo, attenuation);
        } else {
            isSpecularBounce = false;
            if (scene.lights.length > 0) {
                const lightIndex = Math.floor(randomDouble() * scene.lights.length);
                const light = scene.lights[lightIndex];
              if (light) {
                    light.boundingBox(s.lightBox);
                    s.pointOnLight.x = s.lightBox.min.x + randomDouble() * (s.lightBox.max.x - s.lightBox.min.x);
                    s.pointOnLight.y = s.lightBox.min.y + randomDouble() * (s.lightBox.max.y - s.lightBox.min.y);
                    s.pointOnLight.z = s.lightBox.min.z + randomDouble() * (s.lightBox.max.z - s.lightBox.min.z);
                    V.subtract(s.pointOnLight, globalHitRec.point, s.toLight);
                    const distSq = V.lengthSq(s.toLight);
                    V.normalize(s.toLight, s.toLight);
                   const shadowRay = { origin: V.create(), direction: s.toLight };
                V.scale(globalHitRec.normal, 1e-4, s.tempV1);
                V.add(globalHitRec.point, s.tempV1, shadowRay.origin);
               s.shadowRec.reset();
                if (!scene.bvhRoot.intersect(shadowRay, 0.001, Math.sqrt(distSq) - 0.001, s.shadowRec)) {
                        const lightMat = light.material;
                        const cosThetaSurface = Math.max(0.0, V.dot(globalHitRec.normal, s.toLight));
                        const lightNormal = light.normal;
                        const cosThetaLight = Math.max(0.0, V.dot(lightNormal, V.scale(s.toLight, -1, s.tempV2)));
                        if (cosThetaLight > 1e-6) {
                            const lightArea = (s.lightBox.max.x - s.lightBox.min.x) * (s.lightBox.max.z - s.lightBox.min.z);
                            if (lightArea > 1e-6) {
                                const lightPdf = distSq / (lightArea * cosThetaLight);
                                const bsdfPdf = cosThetaSurface / Math.PI;
                                if (lightPdf + bsdfPdf > 1e-6) {
                                    const misWeight = lightPdf / (lightPdf + bsdfPdf);
                                    C.scale(globalHitRec.material.albedo, 1.0 / Math.PI, s.brdf);
                                    C.multiply(lightMat.emissive, s.brdf, s.contrib);
                                    C.scale(s.contrib, cosThetaSurface / lightPdf, s.contrib);
                                    C.scale(s.contrib, misWeight * scene.lights.length, s.contrib);
                                    const clampVal = 4.0;
                                    s.contrib.r = Math.min(s.contrib.r, clampVal); s.contrib.g = Math.min(s.contrib.g, clampVal); s.contrib.b = Math.min(s.contrib.b, clampVal);
                                    C.multiply(attenuation, s.contrib, s.tempV3);
                                    C.add(accumulatedColor, s.tempV3, accumulatedColor);
                                }
                            }
                        }
                    }
                }
            }
            randomCosineDirection(globalHitRec.normal, s.scatterDir);
            C.multiply(attenuation, globalHitRec.material.albedo, attenuation);
        }
        V.scale(globalHitRec.normal, 1e-4, s.tempV1);
        V.add(globalHitRec.point, s.tempV1, currentRay.origin);
        currentRay.direction.x = s.scatterDir.x; currentRay.direction.y = s.scatterDir.y; currentRay.direction.z = s.scatterDir.z;
        if (depth > 3) {
            const p = C.luminance(attenuation);
            if (randomDouble() > p) break;
            if (p > 1e-6) C.scale(attenuation, 1.0 / p, attenuation);
        }
    }
    return accumulatedColor;
}
const ATrousDenoiser = {
    weightFunc: (val, sigma) => Math.exp(-(val * val) / (sigma * sigma)),
    denoise: (colorBuffer, gbufferBuffer, width, height) => {
        const tempColor = new Float32Array(colorBuffer.length);
        const kernel = [0.0625, 0.25, 0.375, 0.25, 0.0625];
        let sigmaC = 1.0, sigmaN = 0.1, sigmaA = 0.2;
        for (let iteration = 0; iteration < 3; iteration++) {
            const step = 1 << iteration;
            const readColor = iteration === 0 ? colorBuffer : tempColor;
            const writeColor = iteration === 0 ? tempColor : colorBuffer;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const centerIdx = (y * width + x) * 3;
                    const cIr = readColor[centerIdx], cIg = readColor[centerIdx + 1], cIb = readColor[centerIdx + 2];
                    const gIdx = (y * width + x) * 6;
                    const gIaR = gbufferBuffer[gIdx], gIaG = gbufferBuffer[gIdx+1], gIaB = gbufferBuffer[gIdx+2];
                    const gInX = gbufferBuffer[gIdx+3], gInY = gbufferBuffer[gIdx+4], gInZ = gbufferBuffer[gIdx+5];
                    let totalR = 0, totalG = 0, totalB = 0, totalWeight = 0.0;
                    for (let j = -2; j <= 2; j++) {
                        for (let i = -2; i <= 2; i++) {
                            const nx = x + i * step, ny = y + j * step;
                            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                                const nIdx = (ny * width + nx) * 3;
                                const cJr = readColor[nIdx], cJg = readColor[nIdx + 1], cJb = readColor[nIdx + 2];
                                const gJIdx = (ny * width + nx) * 6;
                                const gJaR = gbufferBuffer[gJIdx], gJaG = gbufferBuffer[gJIdx+1], gJaB = gbufferBuffer[gJIdx+2];
                                const gJnX = gbufferBuffer[gJIdx+3], gJnY = gbufferBuffer[gJIdx+4], gJnZ = gbufferBuffer[gJIdx+5];
                                const distC = Math.sqrt((cIr - cJr)**2 + (cIg - cJg)**2 + (cIb - cJb)**2);
                                const distN = Math.sqrt(2.0 * (1.0 - (gInX * gJnX + gInY * gJnY + gInZ * gJnZ)));
                                const distA = Math.sqrt((gIaR - gJaR)**2 + (gIaG - gJaG)**2 + (gIaB - gJaB)**2);
                                let w = kernel[j + 2] * kernel[i + 2];
                                w *= ATrousDenoiser.weightFunc(distC, sigmaC);
                                w *= ATrousDenoiser.weightFunc(distN, sigmaN);
                                w *= ATrousDenoiser.weightFunc(distA, sigmaA);
                                totalR += cJr * w; totalG += cJg * w; totalB += cJb * w;
                                totalWeight += w;
                            }
                        }
                    }
                    if (totalWeight > 1e-6) {
                        const invW = 1.0 / totalWeight;
                        writeColor[centerIdx] = totalR * invW; writeColor[centerIdx+1] = totalG * invW; writeColor[centerIdx+2] = totalB * invW;
                    } else {
                        writeColor[centerIdx] = cIr; writeColor[centerIdx+1] = cIg; writeColor[centerIdx+2] = cIb;
                    }
                }
            }
        }
        if (3 % 2 !== 0) colorBuffer.set(tempColor);
    }
};
function generateDemandingScene() {
    const scene = new Scene();
    const objects = [];
    const matWhite = new Material(C.create(0.78, 0.78, 0.78));
    const matRed = new Material(C.create(0.86, 0.2, 0.2));
    const matGreen = new Material(C.create(0.2, 0.86, 0.2));
    const matLight = new Material(C.create(0, 0, 0), C.create(5.88, 5.88, 5.88));
    const matGlass = new Material(C.create(1, 1, 1), C.create(0, 0, 0), 0.0, 0.0, 1.5, 1.0);
    const matMetal = new Material(C.create(0.86, 0.86, 0.86), C.create(0, 0, 0), 1.0, 0.05);
    const matGold = new Material(C.create(0.86, 0.7, 0.2), C.create(0, 0, 0), 1.0, 0.15);
    const matFloor = new Material(C.create(0.78, 0.78, 0.78), C.create(0, 0, 0), 0.2, 0.3);
    const roomDim = 30.0;
    objects.push(new Rect(V.create(-roomDim, -roomDim, roomDim), V.create(roomDim, -roomDim, roomDim), V.create(roomDim, -roomDim, -roomDim), V.create(-roomDim, -roomDim, -roomDim), V.create(0, 1, 0), matFloor));
    objects.push(new Rect(V.create(-roomDim, roomDim, roomDim), V.create(roomDim, roomDim, roomDim), V.create(roomDim, roomDim, -roomDim), V.create(-roomDim, roomDim, -roomDim), V.create(0, -1, 0), matWhite));
    objects.push(new Rect(V.create(-roomDim, -roomDim, roomDim), V.create(roomDim, -roomDim, roomDim), V.create(roomDim, roomDim, roomDim), V.create(-roomDim, roomDim, roomDim), V.create(0, 0, -1), matWhite));
    objects.push(new Rect(V.create(-roomDim, -roomDim, -roomDim), V.create(-roomDim, -roomDim, roomDim), V.create(-roomDim, roomDim, roomDim), V.create(-roomDim, roomDim, -roomDim), V.create(1, 0, 0), matRed));
    objects.push(new Rect(V.create(roomDim, -roomDim, -roomDim), V.create(roomDim, -roomDim, roomDim), V.create(roomDim, roomDim, roomDim), V.create(roomDim, roomDim, -roomDim), V.create(-1, 0, 0), matGreen));
    objects.push(new Rect(V.create(-roomDim, -roomDim, -roomDim), V.create(roomDim, -roomDim, -roomDim), V.create(roomDim, roomDim, -roomDim), V.create(-roomDim, roomDim, -roomDim), V.create(0, 0, 1), matWhite));
    const lightSize = 8.0;
    const lightObj = new Rect(V.create(-lightSize, roomDim - 0.1, -lightSize), V.create(lightSize, roomDim - 0.1, -lightSize), V.create(lightSize, roomDim - 0.1, lightSize), V.create(-lightSize, roomDim - 0.1, lightSize), V.create(0, -1, 0), matLight);
    objects.push(lightObj);
    scene.lights.push(lightObj);
    const spheres = [
      
        { c: [0, -2, -5], r: 2.5, m: matGlass }, { c: [-8, 8, 2], r: 1.8, m: matGlass }, { c: [7, -5, 6], r: 1.2, m: matGlass },
        { c: [10, 2, -10], r: 2.0, m: matGlass }, { c: [-11, -10, 4], r: 1.5, m: matGlass }, { c: [2, 9, 8], r: 1.0, m: matGlass },
        { c: [-5, 5, 5], r: 1.3, m: matGlass }, { c: [0, 10, 0], r: 2.8, m: matGlass }, { c: [12, -12, -8], r: 1.6, m: matGlass },
        { c: [-9, 1, 10], r: 1.1, m: matGlass }, { c: [4, -9, -4], r: 1.9, m: matGlass }, { c: [-2, -10, 7], r: 1.4, m: matGlass },
        { c: [8, 1, -1], r: 0.8, m: matGlass }, { c: [-1, 3, 3], r: 1.0, m: matGlass }, { c: [6, 6, -6], r: 1.7, m: matGlass },
       
        { c: [5, 0, 0], r: 2.0, m: matGold }, { c: [-10, -9, -3], r: 1.5, m: matGold }, { c: [8, -8, 8], r: 1.0, m: matGold },
        { c: [-3, 7, -9], r: 2.2, m: matGold }, { c: [11, 11, 2], r: 1.3, m: matGold }, { c: [-7, 0, 7], r: 1.8, m: matGold },
        { c: [3, -6, 10], r: 1.1, m: matGold }, { c: [-9, 6, -1], r: 1.6, m: matGold }, { c: [1, 1, 11], r: 1.4, m: matGold },
        { c: [9, -3, -7], r: 2.1, m: matGold }, { c: [-6, -6, -6], r: 1.2, m: matGold }, { c: [2, 2, 2], r: 0.9, m: matGold },
        { c: [10, 5, 5], r: 1.5, m: matGold }, { c: [-4, -4, 12], r: 1.7, m: matGold }, { c: [7, 9, -2], r: 1.0, m: matGold },
      
        { c: [-5, -8, 8], r: 2.2, m: matMetal }, { c: [9, 9, 9], r: 1.0, m: matMetal }, { c: [-2, 4, -8], r: 1.8, m: matMetal },
        { c: [6, -10, 1], r: 1.3, m: matMetal }, { c: [-12, 3, 3], r: 2.0, m: matMetal }, { c: [1, 7, -4], r: 1.5, m: matMetal },
        { c: [9, -9, 0], r: 1.1, m: matMetal }, { c: [-7, -2, -10], r: 1.9, m: matMetal }, { c: [5, 12, 4], r: 1.2, m: matMetal },
        { c: [-10, 10, -10], r: 2.4, m: matMetal }, { c: [3, -3, 3], r: 1.0, m: matMetal }, { c: [8, 4, 8], r: 1.6, m: matMetal },
        { c: [-6, 11, -5], r: 1.4, m: matMetal }, { c: [11, -1, 6], r: 1.8, m: matMetal }, { c: [-3, -7, -1], r: 2.0, m: matMetal }
    ];
    spheres.forEach(s => objects.push(new Sphere(V.create(s.c[0], s.c[1], s.c[2]), s.r, s.m)));
    scene.bvhRoot = new BVHNode(objects);
    return scene;
}
function renderJsTile(data) {
    // MODIFICATION: Added challengeSeed to destructuring
    const { tile, canvasWidth, canvasHeight, samplesPerPixel, maxDepth, useDenoiser, challengeSeed } = data;
    const scene = js_scene;
    if (!scene) { self.postMessage({ type: 'error', error: 'JS Scene not initialized before render call.'}); return; }
    const pixelData = new Uint8ClampedArray(tile.size * tile.size * 4);
    const lookfrom=scene.camOrigin,lookat=V.create(0,0,0),vup=V.create(0,1,0),vfov=100,aspectRatio=canvasWidth/canvasHeight,aperture=.05,focusDist=V.length(V.subtract(lookfrom,lookat,V.create())),theta=vfov*Math.PI/180,h=Math.tan(theta/2),viewportHeight=2*h,viewportWidth=aspectRatio*viewportHeight,w=V.create();V.normalize(V.subtract(lookfrom,lookat,V.create()),w);const u=V.create();V.normalize(V.cross(vup,w,V.create()),u);const v=V.create();V.cross(w,u,v);const horizontal=V.create();V.scale(u,viewportWidth*focusDist,horizontal);const vertical=V.create();V.scale(v,viewportHeight*focusDist,vertical);const lowerLeftCorner=V.create(),s=traceScratch;V.scale(horizontal,.5,s.tempV1);V.scale(vertical,.5,s.tempV2);V.add(s.tempV1,s.tempV2,s.tempV3);V.scale(w,focusDist,s.tempV4);V.add(s.tempV3,s.tempV4,s.tempV3);V.subtract(lookfrom,s.tempV3,lowerLeftCorner);const lensRadius=aperture/2;
    const colorBuffer = new Float32Array(tile.size * tile.size * 3);
    const gbufferBuffer = useDenoiser ? new Float32Array(tile.size * tile.size * 6) : null;
    const rd=V.create(),offset=V.create(),rayOrigin=V.create(),pointOnViewport=V.create(),rayDir=V.create(),totalColor=C.create(),totalAlbedo=C.create(),totalNormal=V.create(),ray={origin:rayOrigin,direction:rayDir};
    for (let yOffset = 0; yOffset < tile.size; yOffset++) {
        const y = tile.y + yOffset;
        for (let xOffset = 0; xOffset < tile.size; xOffset++) {
            const x = tile.x + xOffset;
            // MODIFICATION: Pass challengeSeed to PRNG reset
            resetPrngForTile(x, y, canvasWidth, challengeSeed);
            totalColor.r=totalColor.g=totalColor.b=0;
            if(useDenoiser){totalAlbedo.r=totalAlbedo.g=totalAlbedo.b=0;totalNormal.x=totalNormal.y=totalNormal.z=0}
            for (let s = 0; s < samplesPerPixel; s++) {
                const camX=(x+randomDouble())/(canvasWidth-1),camY=1-(y+randomDouble())/(canvasHeight-1);
                randomInUnitDisk(rd);V.scale(rd,lensRadius,rd);V.scale(u,rd.x,offset);V.scale(v,rd.y,traceScratch.tempV1);V.add(offset,traceScratch.tempV1,offset);V.add(lookfrom,offset,rayOrigin);V.scale(horizontal,camX,traceScratch.tempV1);V.scale(vertical,camY,traceScratch.tempV2);V.add(lowerLeftCorner,traceScratch.tempV1,pointOnViewport);V.add(pointOnViewport,traceScratch.tempV2,pointOnViewport);V.subtract(pointOnViewport,rayOrigin,rayDir);V.normalize(rayDir,rayDir);
                globalGBuffer.reset();
                const sampleColor = js_trace(ray, scene, maxDepth, globalGBuffer);
                totalColor.r+=sampleColor.r;totalColor.g+=sampleColor.g;totalColor.b+=sampleColor.b;
                if(useDenoiser){totalAlbedo.r+=globalGBuffer.albedo.r;totalAlbedo.g+=globalGBuffer.albedo.g;totalAlbedo.b+=globalGBuffer.albedo.b;totalNormal.x+=globalGBuffer.normal.x;totalNormal.y+=globalGBuffer.normal.y;totalNormal.z+=globalGBuffer.normal.z}
            }
            const idx=(yOffset*tile.size+xOffset)*3,invSpp=1/samplesPerPixel;
            colorBuffer[idx]=totalColor.r*invSpp;colorBuffer[idx+1]=totalColor.g*invSpp;colorBuffer[idx+2]=totalColor.b*invSpp;
            if(useDenoiser){const gIdx=(yOffset*tile.size+xOffset)*6;gbufferBuffer[gIdx]=totalAlbedo.r*invSpp;gbufferBuffer[gIdx+1]=totalAlbedo.g*invSpp;gbufferBuffer[gIdx+2]=totalAlbedo.b*invSpp;V.scale(totalNormal,invSpp,totalNormal);V.normalize(totalNormal,totalNormal);gbufferBuffer[gIdx+3]=totalNormal.x;gbufferBuffer[gIdx+4]=totalNormal.y;gbufferBuffer[gIdx+5]=totalNormal.z}
        }
    }
    if (useDenoiser) { ATrousDenoiser.denoise(colorBuffer, gbufferBuffer, tile.size, tile.size); }
    for (let i = 0; i < tile.size * tile.size; i++) {
        const idx=i*3;let r=colorBuffer[idx],g=colorBuffer[idx+1],b=colorBuffer[idx+2];
        const exposure=1;r*=exposure;g*=exposure;b*=exposure;
        const a=2.51,bb=.03,c=2.43,d=.59,e=.14;
        r=(r*(a*r+bb))/(r*(c*r+d)+e);g=(g*(a*g+bb))/(g*(c*g+d)+e);b=(b*(a*b+bb))/(b*(c*b+d)+e);
        const gamma=1/2.2;r=Math.pow(r,gamma);g=Math.pow(g,gamma);b=Math.pow(b,gamma);
        const pIdx=i*4;
        pixelData[pIdx]=Math.max(0,Math.min(255,r*255));pixelData[pIdx+1]=Math.max(0,Math.min(255,g*255));pixelData[pIdx+2]=Math.max(0,Math.min(255,b*255));pixelData[pIdx+3]=255;
    }
    self.postMessage({ type: 'result', pixelData, tile }, [pixelData.buffer]);
}
self.onmessage = function(e) {
    const data = e.data;
    switch (data.type) {
        case 'init-wasm':
            workerRole = 'wasm';
            initializeWasm({
                wasmModule: data.wasmModule,
                wasmBinary: data.wasmBinary,
                jsUrl: data.jsUrl,
                isLegacy: data.isLegacy
            });
            break;
        case 'init-scene':
            if (workerRole === 'wasm') {
                if (!wasm_initializeScene) { self.postMessage({ type: 'error', error: 'WASM not ready for scene init' }); return; }
                wasm_initializeScene();
                self.postMessage({ type: 'scene-initialized' });
            } else {
                workerRole = 'javascript';
                if (!js_scene) { js_scene = generateDemandingScene(); }
                self.postMessage({ type: 'scene-initialized' });
            }
            break;
        case 'render-tile':
    if (workerRole === 'javascript') { renderJsTile(data); }
    else if (workerRole === 'wasm') { renderWasmTile(data); }
    else { self.postMessage({ type: 'error', error: 'Worker role not initialized.' }); }
    break;
    }
};

