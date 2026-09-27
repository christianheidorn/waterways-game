import{Ft as e,It as t,Kt as n,N as r,Rt as i,S as a,X as o,Z as s,an as c,c as l,d as u,ft as d,h as f,it as p,jt as m,m as h,nn as g,on as _,st as v,u as y,x as b}from"./three.module-7fLu2X4C.js";import{r as x}from"./Heightfield-B0mrtZdJ.js";var S=class{resolution;channels=8;data;textures;texData;constructor(e,t){this.resolution=e;let n=e*e;if(this.data=t??new Uint8Array(n*8),this.data.length!==n*8)throw Error(`Splat map size mismatch.`);this.texData=[new Uint8Array(n*4),new Uint8Array(n*4)],this.textures=[this.makeTexture(this.texData[0]),this.makeTexture(this.texData[1])],this.syncRect({x0:0,z0:0,x1:e-1,z1:e-1})}syncRect(e){let t=this.resolution,[n,r]=this.texData;for(let i=e.z0;i<=e.z1;i++)for(let a=e.x0;a<=e.x1;a++){let e=i*t+a,o=e*8,s=e*4;n[s]=this.data[o],n[s+1]=this.data[o+1],n[s+2]=this.data[o+2],n[s+3]=this.data[o+3],r[s]=this.data[o+4],r[s+1]=this.data[o+5],r[s+2]=this.data[o+6],r[s+3]=this.data[o+7]}for(let e of this.textures)e.needsUpdate=!0}paint(e,t,n,r){let i=(t*this.resolution+e)*8,a=this.data,o=a[i+n]/255,s=Math.min(1,Math.max(0,o+r));if(s===o)return;let c=1-o,l=1-s,u=0;for(let e=0;e<8;e++){if(e===n)continue;let t=c>1e-6?a[i+e]/255*(l/c):0;a[i+e]=Math.round(t*255),u+=a[i+e]}let d=Math.max(0,255-u);if(c<=1e-6&&s<o){let e=+(n===0);a[i+e]=Math.round((o-s)*255),d=255-a[i+e]}a[i+n]=d}fill(e){this.data.fill(0);for(let t=0;t<this.resolution*this.resolution;t++)this.data[t*8+e]=255;this.syncRect({x0:0,z0:0,x1:this.resolution-1,z1:this.resolution-1})}autoPaint(e,t,n){let r=this.resolution,i=n??{x0:0,z0:0,x1:r-1,z1:r-1},a=t.filter(e=>e.auto_min_height!==null||e.auto_max_height!==null||e.auto_min_slope!==null||e.auto_max_slope!==null).sort((e,t)=>e.auto_priority-t.auto_priority),o=t.find(e=>!a.includes(e))??t[0];if(!o)return;let s=new Float32Array(8),c=[0,1,0],l=e.minMax(),u=Math.max(1,(l.max-l.min)*.01);for(let t=i.z0;t<=i.z1;t++)for(let n=i.x0;n<=i.x1;n++){e.normalAtSample(n,t,c,0);let i=Math.acos(Math.min(1,c[1]))*180/Math.PI,l=e.data[t*r+n];s.fill(0),s[o.slot]=1;for(let e of a){let t=1;if(t*=C(l,e.auto_min_height,e.auto_max_height,u),t*=C(i,e.auto_min_slope,e.auto_max_slope,4),!(t<=0)){for(let e=0;e<8;e++)s[e]*=1-t;s[e.slot]+=t}}let d=(t*r+n)*8,f=0;for(let e=0;e<8;e++)f+=s[e];let p=0;for(let e=1;e<8;e++){let t=Math.round(s[e]/f*255);this.data[d+e]=t,p+=t}this.data[d]=Math.max(0,255-p)}this.syncRect(i)}dispose(){for(let e of this.textures)e.dispose()}makeTexture(e){let t=new a(e,this.resolution,this.resolution,m,g);return t.magFilter=o,t.minFilter=o,t.wrapS=t.wrapT=h,t.generateMipmaps=!1,t.needsUpdate=!0,t}};function C(e,t,n,r){let i=1;return t!==null&&(i*=w(t-r,t+r,e)),n!==null&&(i*=1-w(n-r,n+r,e)),i}function w(e,t,n){let r=Math.min(1,Math.max(0,(n-e)/(t-e)));return r*r*(3-2*r)}var T=64,E=5,D=class{heights;material;group=new r;chunks=[];chunksPerSide;lodBias=1;lodIndices=[];skirtDepth;constructor(e,t){if(this.heights=e,this.material=t,(e.resolution-1)%T!=0)throw Error(`Heightmap resolution must be 64·n + 1, got ${e.resolution}.`);this.group.name=`Terrain`,this.chunksPerSide=(e.resolution-1)/T,this.skirtDepth=Math.max(4,e.cell*6),this.buildIndices();for(let e=0;e<this.chunksPerSide;e++)for(let t=0;t<this.chunksPerSide;t++)this.chunks.push(this.createChunk(t*T,e*T))}updateLod(e){let t=T*this.heights.cell,n=e.position;for(let e of this.chunks){let r=e.box.distanceToPoint(n)/(t*1.2*this.lodBias),i=Math.min(E,Math.max(0,Math.floor(Math.log2(Math.max(1,r))+ +(r>1))));i!==e.lod&&(e.lod=i,e.geometry.setIndex(this.lodIndices[i]))}}updateRect(e){let t={x0:Math.max(0,e.x0-1),z0:Math.max(0,e.z0-1),x1:Math.min(this.heights.resolution-1,e.x1+1),z1:Math.min(this.heights.resolution-1,e.z1+1)};for(let e of this.chunks){let n=e.col0+T,r=e.row0+T;t.x1<e.col0||t.x0>n||t.z1<e.row0||t.z0>r||this.writeChunk(e,{x0:Math.max(t.x0,e.col0)-e.col0,z0:Math.max(t.z0,e.row0)-e.row0,x1:Math.min(t.x1,n)-e.col0,z1:Math.min(t.z1,r)-e.row0})}}updateAll(){this.updateRect({x0:0,z0:0,x1:this.heights.resolution-1,z1:this.heights.resolution-1})}setShadows(e){for(let t of this.chunks)t.mesh.castShadow=e}dispose(){for(let e of this.chunks)e.geometry.dispose();this.group.clear()}createChunk(e,t){let n=4485,r=new u,i=new Float32Array(n*3),a=new Float32Array(n*3);r.setAttribute(`position`,new y(i,3)),r.setAttribute(`normal`,new y(a,3)),r.setIndex(this.lodIndices[0]);let o=new v(r,this.material);o.receiveShadow=!0,o.castShadow=!0,o.matrixAutoUpdate=!1,o.name=`TerrainChunk_${e}_${t}`,this.group.add(o);let s={mesh:o,geometry:r,col0:e,row0:t,center:new c,box:new l,lod:0};for(let n=0;n<65;n++)for(let r=0;r<65;r++){let a=(n*65+r)*3;i[a]=this.heights.colToX(e+r),i[a+2]=this.heights.rowToZ(t+n)}for(let n=0;n<4;n++)for(let r=0;r<65;r++){let[a,o]=O(n,r,T),s=(4225+n*65+r)*3;i[s]=this.heights.colToX(e+a),i[s+2]=this.heights.rowToZ(t+o)}return this.writeChunk(s,{x0:0,z0:0,x1:T,z1:T}),s}writeChunk(e,t){let r=this.heights,i=e.geometry.getAttribute(`position`),a=e.geometry.getAttribute(`normal`),o=i.array,s=a.array;for(let n=t.z0;n<=t.z1;n++)for(let i=t.x0;i<=t.x1;i++){let t=e.col0+i,a=e.row0+n,c=n*65+i;o[c*3+1]=r.data[a*r.resolution+t],r.normalAtSample(t,a,s,c*3)}for(let e=0;e<4;e++)for(let n=0;n<65;n++){let[r,i]=O(e,n,T);if(r<t.x0||r>t.x1||i<t.z0||i>t.z1)continue;let a=i*65+r,c=4225+e*65+n;o[c*3+1]=o[a*3+1]-this.skirtDepth,s[c*3]=s[a*3],s[c*3+1]=s[a*3+1],s[c*3+2]=s[a*3+2]}i.needsUpdate=!0,a.needsUpdate=!0;let l=1/0,u=-1/0;for(let e=0;e<4225;e++){let t=o[e*3+1];l=Math.min(l,t),u=Math.max(u,t)}e.box.set(new c(r.colToX(e.col0),l-this.skirtDepth,r.rowToZ(e.row0)),new c(r.colToX(e.col0+T),u,r.rowToZ(e.row0+T))),e.box.getCenter(e.center),e.geometry.boundingBox=e.box.clone(),e.geometry.boundingSphere=e.box.getBoundingSphere(new n)}buildIndices(){for(let e=0;e<=E;e++){let t=1<<e,n=[],r=(e,t)=>t*65+e,i=(e,t)=>4225+e*65+t;for(let e=0;e<T;e+=t)for(let i=0;i<T;i+=t){let a=r(i,e),o=r(i,e+t),s=r(i+t,e),c=r(i+t,e+t);(i/t+e/t)%2==0?n.push(a,o,s,s,o,c):n.push(a,o,c,a,c,s)}for(let e=0;e<T;e+=t)n.push(r(e,0),r(e+t,0),i(0,e),r(e+t,0),i(0,e+t),i(0,e)),n.push(r(e,T),i(1,e),r(e+t,T),r(e+t,T),i(1,e),i(1,e+t)),n.push(r(0,e),i(2,e),r(0,e+t),r(0,e+t),i(2,e),i(2,e+t)),n.push(r(T,e),r(T,e+t),i(3,e),r(T,e+t),i(3,e+t),i(3,e));this.lodIndices.push(new y(new Uint16Array(n),1))}}};function O(e,t,n){switch(e){case 0:return[t,0];case 1:return[t,n];case 2:return[0,t];default:return[n,t]}}var k=class{albedoRough;normalAoHeight;size;albedoData;detailData;slots=Array.from({length:8},()=>({key:null,ready:!1}));canvas;ctx;onSlotReady=null;constructor(e){this.size=e;let t=e*e*4;this.albedoData=new Uint8Array(t*8),this.detailData=new Uint8Array(t*8),this.albedoRough=this.makeArray(this.albedoData,i),this.normalAoHeight=this.makeArray(this.detailData,``),this.canvas=typeof OffscreenCanvas<`u`?new OffscreenCanvas(e,e):Object.assign(document.createElement(`canvas`),{width:e,height:e});let n=this.canvas.getContext(`2d`,{willReadFrequently:!0});if(!n)throw Error(`2D canvas unavailable for terrain texture packing.`);this.ctx=n}isReady(e){return this.slots[e]?.ready??!1}async load(e,t,n=.85){let r=t?JSON.stringify(t.maps):null,i=this.slots[e];if(i.key!==r&&(i.key=r,i.ready=!1,this.onSlotReady?.(e,!1),t?.maps.albedo))try{let[a,o,s,c,l]=await Promise.all([`albedo`,`normal`,`roughness`,`ao`,`height`].map(e=>this.decode(t.maps[e])));if(i.key!==r||!a)return;let u=this.size*this.size,d=this.albedoData.subarray(e*u*4,(e+1)*u*4),f=this.detailData.subarray(e*u*4,(e+1)*u*4),m=Math.round(p.clamp(n,0,1)*255);for(let e=0;e<u;e++){let t=e*4;d[t]=a[t],d[t+1]=a[t+1],d[t+2]=a[t+2],d[t+3]=s?s[t]:m,f[t]=o?o[t]:128,f[t+1]=o?o[t+1]:128,f[t+2]=c?c[t]:255,f[t+3]=l?l[t]:128}this.albedoRough.addLayerUpdate(e),this.normalAoHeight.addLayerUpdate(e),this.albedoRough.needsUpdate=!0,this.normalAoHeight.needsUpdate=!0,i.ready=!0,this.onSlotReady?.(e,!0)}catch(t){console.warn(`Terrain material for slot ${e} failed to load`,t)}}clear(e){this.slots[e]={key:null,ready:!1},this.onSlotReady?.(e,!1)}dispose(){this.albedoRough.dispose(),this.normalAoHeight.dispose()}async decode(e){if(!e)return null;let t=await fetch(e,{credentials:`same-origin`});if(!t.ok)return null;let n=await t.blob(),r=await createImageBitmap(n,{resizeWidth:this.size,resizeHeight:this.size,resizeQuality:`high`,colorSpaceConversion:`none`,premultiplyAlpha:`none`});return this.ctx.clearRect(0,0,this.size,this.size),this.ctx.drawImage(r,0,0,this.size,this.size),r.close(),this.ctx.getImageData(0,0,this.size,this.size).data}makeArray(e,n){let r=new b(e,this.size,this.size,8);return r.format=m,r.type=g,r.wrapS=r.wrapT=t,r.minFilter=s,r.magFilter=o,r.generateMipmaps=!0,r.anisotropy=8,r.colorSpace=n,r.needsUpdate=!0,r}},A=class extends d{uniforms;textures;layers=[];constructor(t,n,r,i=1024){super({roughness:1,metalness:0,envMapIntensity:.45}),this.textures=this.createTextures(i);let o=new a(new Uint8Array([0]),1,1,e);o.needsUpdate=!0,this.uniforms={uSplat0:{value:t.textures[0]},uSplat1:{value:t.textures[1]},uNoise:{value:M()},uAlbedoArr:{value:this.textures.albedoRough},uDetailArr:{value:this.textures.normalAoHeight},uWet:{value:o},uMapHalf:{value:n/2},uCell:{value:n/(r-1)},uRes:{value:r},uColorA:{value:Array.from({length:8},()=>new f)},uColorB:{value:Array.from({length:8},()=>new f)},uParams:{value:Array.from({length:8},()=>new _(8,.5,.9,.5))},uMat:{value:Array.from({length:8},()=>new _(0,0,4,1))},uMat2:{value:Array.from({length:8},()=>new _(1,1,.5,0))},uTint:{value:Array.from({length:8},()=>new f(1,1,1))},uBrush:{value:new _(0,0,0,.5)},uBrushVisible:{value:0},uBrushColor:{value:new f(.25,.75,1)},uGridVisible:{value:0}},this.onBeforeCompile=e=>{Object.assign(e.uniforms,this.uniforms),e.vertexShader=e.vertexShader.replace(`#include <common>`,`#include <common>
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;`).replace(`#include <begin_vertex>`,`#include <begin_vertex>
vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`),e.fragmentShader=e.fragmentShader.replace(`#include <common>`,`#include <common>\n${N}`).replace(`#include <map_fragment>`,P).replace(`#include <roughnessmap_fragment>`,`float roughnessFactor = terrainRoughness;`).replace(`#include <normal_fragment_maps>`,F).replace(`#include <aomap_fragment>`,I).replace(`#include <emissivemap_fragment>`,L)},this.customProgramCacheKey=()=>`waterways-terrain-v2`}get textureSize(){return this.textures.size}setTextureSize(e){e!==this.textures.size&&(this.textures.dispose(),this.textures=this.createTextures(e),this.uniforms.uAlbedoArr.value=this.textures.albedoRough,this.uniforms.uDetailArr.value=this.textures.normalAoHeight,this.setLayers(this.layers))}setLayers(e){this.layers=e;let t=this.uniforms.uColorA.value,n=this.uniforms.uColorB.value,r=this.uniforms.uParams.value,i=this.uniforms.uMat.value,a=this.uniforms.uMat2.value,o=this.uniforms.uTint.value,s=new Set;for(let e=0;e<8;e++)i[e].x=0;for(let c of e){let e=c.slot;s.add(e),t[e].set(c.color),n[e].set(c.color_secondary),r[e].set(Math.max(.1,c.noise_scale),c.variation,c.roughness,c.bump);let l=j(c),u=Math.max(.05,c.texture_scale||l?.tile_size||4);i[e].set(1,this.textures.isReady(e)&&l?1:0,u,l?.height_contrast??1),a[e].set((c.roughness_scale??1)*(l?.roughness_scale??1),(c.normal_strength??1)*(l?.normal_strength??1),c.variation,0),o[e].set(c.tint??`#ffffff`).multiply(new f(l?.tint??`#ffffff`)),this.textures.load(e,l,c.roughness)}for(let e=0;e<8;e++)s.has(e)||this.textures.clear(e)}setWetness(e){this.uniforms.uWet.value=e}setBrush(e){this.uniforms.uBrush.value.set(e.x,e.z,e.radius,e.falloff),this.uniforms.uBrushVisible.value=+!!e.visible,this.uniforms.uBrushColor.value.copy(e.color)}hideBrush(){this.uniforms.uBrushVisible.value=0}setGridVisible(e){this.uniforms.uGridVisible.value=+!!e}dispose(){this.uniforms.uNoise.value.dispose(),this.textures.dispose(),super.dispose()}createTextures(e){let t=new k(e);return t.onSlotReady=(e,t)=>{let n=this.uniforms?.uMat.value;n&&(n[e].y=+!!t)},t}};function j(e){return e.material?.maps.albedo?e.material:e.texture_url?{id:-1,name:e.name,maps:{albedo:e.texture_url,normal:null,roughness:null,ao:null,height:null},tile_size:e.texture_scale,tint:`#ffffff`,roughness_scale:1,normal_strength:1,height_contrast:1}:null}function M(){let e=new Uint8Array(262144),n=[new x(11),new x(23),new x(37),new x(51)],r=[4,8,16,2];for(let t=0;t<256;t++)for(let i=0;i<256;i++){let a=i/256*Math.PI*2,o=t/256*Math.PI*2;for(let s=0;s<4;s++){let c=r[s]/(Math.PI*2),l=Math.cos(a)*c,u=Math.sin(a)*c,d=Math.cos(o)*c,f=Math.sin(o)*c,p=n[s].fbm(l*3+d*1.7,u*3+f*1.7,4)*.6+n[s].noise2D(d*5+11.3,f*5-7.1)*.4;e[(t*256+i)*4+s]=Math.max(0,Math.min(255,Math.round((p*.5+.5)*255)))}}let i=new a(e,256,256,m);return i.wrapS=i.wrapT=t,i.minFilter=s,i.magFilter=o,i.generateMipmaps=!0,i.needsUpdate=!0,i}var N=`
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
uniform sampler2D uSplat0;
uniform sampler2D uSplat1;
uniform sampler2D uNoise;
uniform sampler2D uWet;
uniform highp sampler2DArray uAlbedoArr;
uniform highp sampler2DArray uDetailArr;
uniform float uMapHalf;
uniform float uCell;
uniform float uRes;
uniform vec3 uColorA[8];
uniform vec3 uColorB[8];
uniform vec4 uParams[8];
uniform vec4 uMat[8];
uniform vec4 uMat2[8];
uniform vec3 uTint[8];
uniform vec4 uBrush;
uniform float uBrushVisible;
uniform vec3 uBrushColor;
uniform float uGridVisible;

float terrainRoughness = 1.0;
float terrainBump = 0.0;       // procedural bump height (layers without material)
float terrainAO = 1.0;
vec3 terrainWorldNormal = vec3(0.0, 1.0, 0.0);

vec3 perturbNormalTerrain(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
    vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
    vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
    vec3 R1 = cross(vSigmaY, surf_norm);
    vec3 R2 = cross(surf_norm, vSigmaX);
    float fDet = dot(vSigmaX, R1) * faceDir;
    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
    return normalize(abs(fDet) * surf_norm - vGrad);
}

// Anti-tiling: two lookups with per-cell random offsets, cross-faded by a low-frequency noise
// (after Inigo Quilez, "texture repetition", technique 3). Samples albedo+rough and detail with
// the same blend so the maps stay consistent.
void sampleLayer(vec2 uv, float layer, vec2 ddx, vec2 ddy, float k, out vec4 albedoRough, out vec4 detail) {
    float l = k * 8.0;
    float f = fract(l);
    float ia = floor(l);
    float ib = ia + 1.0;
    vec2 oa = sin(vec2(3.0, 7.0) * ia);
    vec2 ob = sin(vec2(3.0, 7.0) * ib);
    vec4 a1 = textureGrad(uAlbedoArr, vec3(uv + oa, layer), ddx, ddy);
    vec4 b1 = textureGrad(uAlbedoArr, vec3(uv + ob, layer), ddx, ddy);
    vec4 a2 = textureGrad(uDetailArr, vec3(uv + oa, layer), ddx, ddy);
    vec4 b2 = textureGrad(uDetailArr, vec3(uv + ob, layer), ddx, ddy);
    float t = smoothstep(0.2, 0.8, f - 0.1 * dot(a1.rgb - b1.rgb, vec3(1.0)));
    albedoRough = mix(a1, b1, t);
    detail = mix(a2, b2, t);
}

// Tangent-space normal from the packed detail map (OpenGL convention; v grows southwards on the
// ground so green is flipped), scaled by strength.
vec3 unpackNormal(vec4 detail, float strength) {
    vec2 xy = (detail.rg * 2.0 - 1.0) * strength;
    xy.y = -xy.y;
    return vec3(xy, sqrt(max(1.0 - dot(xy, xy), 0.05)));
}
`,P=`
{
    vec3 wpos = vTerrainPos;
    vec2 wp = wpos.xz;
    vec3 N = normalize(vTerrainNormal);
    vec2 splatUv = ((wp + uMapHalf) / uCell + 0.5) / uRes;
    vec4 s0 = texture2D(uSplat0, splatUv);
    vec4 s1 = texture2D(uSplat1, splatUv);
    float w[8];
    w[0] = s0.r; w[1] = s0.g; w[2] = s0.b; w[3] = s0.a;
    w[4] = s1.r; w[5] = s1.g; w[6] = s1.b; w[7] = s1.a;

    float dist = length(vViewPosition);
    vec4 macro = texture2D(uNoise, wp / 420.0);
    vec4 macro2 = texture2D(uNoise, wp / 97.0);
    float tileNoise = texture2D(uNoise, wp / 61.0).a;

    // Triplanar weights for steep ground (cliffs); flat ground only uses the top projection.
    vec3 tw = pow(abs(N), vec3(4.0));
    tw /= (tw.x + tw.y + tw.z);
    bool steep = tw.y < 0.97;
    vec3 axisSign = sign(N);

    // Screen-space derivatives of world position (for mip selection with textureGrad).
    vec3 dpx = dFdx(wpos);
    vec3 dpy = dFdy(wpos);

    // ---- pass 1: sample every active layer
    vec3 lAlbedo[8];
    vec3 lNormal[8];
    float lRough[8];
    float lAO[8];
    float lHeight[8];
    float farFade = smoothstep(35.0, 220.0, dist);
    float normalFade = 1.0 - 0.75 * smoothstep(60.0, 450.0, dist);

    for (int i = 0; i < 8; i++) {
        w[i] *= uMat[i].x;
        lAlbedo[i] = vec3(0.0);
        lNormal[i] = N;
        lRough[i] = 1.0;
        lAO[i] = 1.0;
        lHeight[i] = 0.5;

        if (w[i] < 0.004) continue;

        if (uMat[i].y > 0.5) {
            float tile = uMat[i].z;
            float li = float(i);
            vec4 ar;
            vec4 dt;
            vec2 uvT = wp / tile;
            sampleLayer(uvT, li, dpx.xz / tile, dpy.xz / tile, tileNoise, ar, dt);

            // Far away, blend with a 4× larger lookup to break visible repetition.
            vec4 farAR = textureGrad(uAlbedoArr, vec3(uvT * 0.23 + 0.31, li), dpx.xz / tile * 0.23, dpy.xz / tile * 0.23);
            ar.rgb = mix(ar.rgb, mix(ar.rgb, farAR.rgb, 0.5), farFade);

            float strength = uMat2[i].y * normalFade;
            vec3 tnY = unpackNormal(dt, strength);
            vec3 albedo = ar.rgb;
            float rough = ar.a;
            float ao = dt.b;
            float h = dt.a;
            // Whiteout-blended triplanar normal (Ben Golus); top projection only on flat ground.
            vec3 nY = vec3(tnY.x + N.x, abs(tnY.z) * N.y, tnY.y + N.z);
            vec3 nSum = nY * tw.y;

            if (steep) {
                vec2 uvX = vec2(wpos.z * axisSign.x, -wpos.y) / tile;
                vec2 uvZ = vec2(-wpos.x * axisSign.z, -wpos.y) / tile;
                vec2 gxX = vec2(dpx.z * axisSign.x, -dpx.y) / tile;
                vec2 gyX = vec2(dpy.z * axisSign.x, -dpy.y) / tile;
                vec2 gxZ = vec2(-dpx.x * axisSign.z, -dpx.y) / tile;
                vec2 gyZ = vec2(-dpy.x * axisSign.z, -dpy.y) / tile;
                vec4 arX = textureGrad(uAlbedoArr, vec3(uvX, li), gxX, gyX);
                vec4 dtX = textureGrad(uDetailArr, vec3(uvX, li), gxX, gyX);
                vec4 arZ = textureGrad(uAlbedoArr, vec3(uvZ, li), gxZ, gyZ);
                vec4 dtZ = textureGrad(uDetailArr, vec3(uvZ, li), gxZ, gyZ);
                vec3 tnX = unpackNormal(dtX, strength);
                vec3 tnZ = unpackNormal(dtZ, strength);
                tnX.x *= axisSign.x;
                tnZ.x *= -axisSign.z;
                vec3 nX = vec3(abs(tnX.z) * N.x, -tnX.y + N.y, tnX.x + N.z);
                vec3 nZ = vec3(tnZ.x + N.x, -tnZ.y + N.y, abs(tnZ.z) * N.z);
                nSum += nX * tw.x + nZ * tw.z;
                albedo = albedo * tw.y + arX.rgb * tw.x + arZ.rgb * tw.z;
                rough = rough * tw.y + arX.a * tw.x + arZ.a * tw.z;
                ao = ao * tw.y + dtX.b * tw.x + dtZ.b * tw.z;
                h = h * tw.y + dtX.a * tw.x + dtZ.a * tw.z;
            }

            // Gentle macro variation so large areas don't look uniform.
            albedo *= 0.9 + (macro2.g - 0.5) * 0.25 * uMat2[i].z + macro.r * 0.12;
            lAlbedo[i] = albedo * uTint[i];
            lNormal[i] = normalize(nSum);
            lRough[i] = clamp(rough * uMat2[i].x, 0.03, 1.0);
            lAO[i] = ao;
            lHeight[i] = clamp((h - 0.5) * uMat[i].w + 0.5, 0.0, 1.0);
        } else {
            // Procedural fallback: two colours mixed by noise.
            vec4 n = texture2D(uNoise, wp / uParams[i].x);
            vec4 nFine = texture2D(uNoise, wp / (uParams[i].x * 0.23));
            float t = clamp((n.b * 0.65 + nFine.r * 0.35 - 0.5) * (1.0 + uParams[i].y * 3.0) + 0.5, 0.0, 1.0);
            vec3 c = mix(uColorA[i], uColorB[i], smoothstep(0.2, 0.8, t) * uParams[i].y + (1.0 - uParams[i].y) * 0.25);
            c *= 0.92 + nFine.g * 0.16;
            c *= 0.88 + macro.r * 0.2 + (macro2.g - 0.5) * 0.08;
            lAlbedo[i] = c;
            lRough[i] = uParams[i].z;
            lHeight[i] = n.r * 0.6 + n.g * 0.4;
            lAO[i] = 1.0;
        }
    }

    // ---- pass 2: height-based blend weights (sharp, natural transitions)
    float best = -1.0;
    for (int i = 0; i < 8; i++) {
        if (w[i] >= 0.004) best = max(best, w[i] + lHeight[i] * 0.5);
    }

    float total = 0.0;
    for (int i = 0; i < 8; i++) {
        float b = w[i] >= 0.004 ? max(w[i] + lHeight[i] * 0.5 - best + 0.18, 0.0) : 0.0;
        w[i] = b;
        total += b;
    }

    vec3 albedo = vec3(0.0);
    vec3 nrm = vec3(0.0);
    float rough = 0.0;
    float ao = 0.0;
    float bumpH = 0.0;

    if (total < 1e-4) {
        albedo = uColorA[0];
        nrm = N;
        rough = 0.9;
        ao = 1.0;
    } else {
        for (int i = 0; i < 8; i++) {
            float wi = w[i] / total;
            if (wi <= 0.0) continue;
            albedo += lAlbedo[i] * wi;
            nrm += lNormal[i] * wi;
            rough += lRough[i] * wi;
            ao += lAO[i] * wi;
            bumpH += (uMat[i].y > 0.5 ? 0.0 : lHeight[i] * uParams[i].w) * wi;
        }
    }

    // Wet ground along water: darker, glossier, smoother.
    float wet = texture2D(uWet, splatUv).r;
    albedo *= mix(1.0, 0.55, wet);
    rough = mix(rough, 0.12, wet * 0.85);
    nrm = normalize(mix(nrm, N, wet * 0.5));

    diffuseColor.rgb *= albedo;
    terrainRoughness = clamp(rough, 0.03, 1.0);
    terrainAO = mix(1.0, ao, 0.85);
    terrainBump = bumpH;
    terrainWorldNormal = normalize(nrm);
}
`,F=`
#include <normal_fragment_maps>
{
    normal = normalize((viewMatrix * vec4(terrainWorldNormal, 0.0)).xyz);
    // Procedural bump for layers without a material; faded with distance to avoid moiré.
    float bumpFade = 1.0 - smoothstep(40.0, 260.0, length(vViewPosition));
    vec2 dH = vec2(dFdx(terrainBump), dFdy(terrainBump)) * 0.22 * bumpFade;
    normal = perturbNormalTerrain(-vViewPosition, normal, dH, faceDirection);
}
`,I=`
reflectedLight.indirectDiffuse *= terrainAO;
reflectedLight.indirectSpecular *= terrainAO;
`,L=`
#include <emissivemap_fragment>
if (uBrushVisible > 0.5) {
    float d = length(vTerrainPos.xz - uBrush.xy);
    float px = fwidth(d) * 1.5;
    float outer = 1.0 - smoothstep(0.0, px, abs(d - uBrush.z));
    float innerR = uBrush.z * (1.0 - uBrush.w);
    float inner = (1.0 - smoothstep(0.0, px, abs(d - innerR))) * 0.6;
    float fill = (1.0 - smoothstep(innerR, uBrush.z, d)) * step(d, uBrush.z) * 0.12;
    float dot_ = 1.0 - smoothstep(0.0, px * 2.0, d - px * 2.0);
    totalEmissiveRadiance += uBrushColor * (outer + inner + fill + dot_);
}
if (uGridVisible > 0.5) {
    vec2 g = abs(fract(vTerrainPos.xz / 100.0 - 0.5) - 0.5) / fwidth(vTerrainPos.xz / 100.0);
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    totalEmissiveRadiance += vec3(0.6) * line * 0.25;
}
`;export{D as n,S as r,A as t};