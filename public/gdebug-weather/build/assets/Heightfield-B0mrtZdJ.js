import{Vt as e,an as t,c as n,it as r,l as i,st as a,tn as o}from"./three.module-7fLu2X4C.js";var s=-1e5;function c(e){let t=e>>>0;return()=>{t=t+1831565813>>>0;let e=t;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}}var l=.5*(Math.sqrt(3)-1),u=(3-Math.sqrt(3))/6,d=[[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]],f=class{perm=new Uint8Array(512);constructor(e=1337){let t=c(e),n=new Uint8Array(256);for(let e=0;e<256;e++)n[e]=e;for(let e=255;e>0;e--){let r=Math.floor(t()*(e+1));[n[e],n[r]]=[n[r],n[e]]}for(let e=0;e<512;e++)this.perm[e]=n[e&255]}noise2D(e,t){let n=this.perm,r=(e+t)*l,i=Math.floor(e+r),a=Math.floor(t+r),o=(i+a)*u,s=e-(i-o),c=t-(a-o),f=+(s>c),p=s>c?0:1,m=s-f+u,h=c-p+u,g=s-1+2*u,_=c-1+2*u,v=i&255,y=a&255,b=0,x=.5-s*s-c*c;if(x>0){let e=d[n[v+n[y]]&7];x*=x,b+=x*x*(e[0]*s+e[1]*c)}let S=.5-m*m-h*h;if(S>0){let e=d[n[v+f+n[y+p]]&7];S*=S,b+=S*S*(e[0]*m+e[1]*h)}let C=.5-g*g-_*_;if(C>0){let e=d[n[v+1+n[y+1]]&7];C*=C,b+=C*C*(e[0]*g+e[1]*_)}return 70*b}fbm(e,t,n=5,r=2,i=.5){let a=1,o=1,s=0,c=0;for(let l=0;l<n;l++)s+=a*this.noise2D(e*o,t*o),c+=a,a*=i,o*=r;return s/c}ridged(e,t,n=5,r=2,i=.5){let a=.5,o=1,s=0,c=1;for(let l=0;l<n;l++){let n=1-Math.abs(this.noise2D(e*o,t*o));n*=n*c,c=Math.min(1,Math.max(0,n*2)),s+=n*a,a*=i,o*=r}return Math.min(1,s)}},p=class t extends a{constructor(){let n=t.SkyShader,r=new e({name:n.name,uniforms:o.clone(n.uniforms),vertexShader:n.vertexShader,fragmentShader:n.fragmentShader,side:1,depthWrite:!1});super(new i(1,1,1),r),this.isSky=!0}};p.SkyShader={name:`SkyShader`,uniforms:{turbidity:{value:2},rayleigh:{value:1},mieCoefficient:{value:.005},mieDirectionalG:{value:.8},sunPosition:{value:new t},cloudScale:{value:2e-4},cloudSpeed:{value:2e-5},cloudCoverage:{value:.4},cloudDensity:{value:.4},cloudElevation:{value:.5},showSunDisc:{value:1},time:{value:0}},vertexShader:`
		uniform vec3 sunPosition;
		uniform float rayleigh;
		uniform float turbidity;
		uniform float mieCoefficient;

		varying vec3 vWorldPosition;
		varying vec3 vSunDirection;
		varying float vSunfade;
		varying vec3 vBetaR;
		varying vec3 vBetaM;
		varying float vSunE;

		// constants for atmospheric scattering
		const float e = 2.71828182845904523536028747135266249775724709369995957;
		const float pi = 3.141592653589793238462643383279502884197169;

		// wavelength of used primaries, according to preetham
		const vec3 lambda = vec3( 680E-9, 550E-9, 450E-9 );
		// this pre-calculation replaces older TotalRayleigh(vec3 lambda) function:
		// (8.0 * pow(pi, 3.0) * pow(pow(n, 2.0) - 1.0, 2.0) * (6.0 + 3.0 * pn)) / (3.0 * N * pow(lambda, vec3(4.0)) * (6.0 - 7.0 * pn))
		const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );

		// mie stuff
		// K coefficient for the primaries
		const float v = 4.0;
		const vec3 K = vec3( 0.686, 0.678, 0.666 );
		// MieConst = pi * pow( ( 2.0 * pi ) / lambda, vec3( v - 2.0 ) ) * K
		const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

		// earth shadow hack
		// cutoffAngle = pi / 1.95;
		const float cutoffAngle = 1.6110731556870734;
		const float steepness = 1.5;
		const float EE = 1000.0;

		float sunIntensity( float zenithAngleCos ) {
			zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
			return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
		}

		vec3 totalMie( float T ) {
			float c = ( 0.2 * T ) * 10E-18;
			return 0.434 * c * MieConst;
		}

		void main() {

			vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
			vWorldPosition = worldPosition.xyz;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
			gl_Position.z = gl_Position.w; // set z to camera.far

			vSunDirection = normalize( sunPosition );

			vSunE = sunIntensity( vSunDirection.y );

			vSunfade = 1.0 - clamp( 1.0 - exp( ( sunPosition.y / 450000.0 ) ), 0.0, 1.0 );

			float rayleighCoefficient = rayleigh - ( 1.0 * ( 1.0 - vSunfade ) );

			// extinction (absorption + out scattering)
			// rayleigh coefficients
			vBetaR = totalRayleigh * rayleighCoefficient;

			// mie coefficients
			vBetaM = totalMie( turbidity ) * mieCoefficient;

		}`,fragmentShader:`
		varying vec3 vWorldPosition;
		varying vec3 vSunDirection;
		varying vec3 vBetaR;
		varying vec3 vBetaM;
		varying float vSunE;

		uniform float mieDirectionalG;
		uniform float cloudScale;
		uniform float cloudSpeed;
		uniform float cloudCoverage;
		uniform float cloudDensity;
		uniform float cloudElevation;
		uniform float showSunDisc;
		uniform float time;

		// gradient at a lattice corner; sinless hash so every GPU produces the same clouds
		vec2 gradient( vec2 i ) {
			vec3 p = fract( i.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
			p += dot( p, p.yzx + 33.33 );
			return fract( ( p.xx + p.yz ) * p.zy ) * 2.0 - 1.0;
		}

		// 2D gradient noise: isotropic lobes like Perlin at value-noise cost
		float noise( vec2 p ) {
			vec2 i = floor( p );
			vec2 f = fract( p );
			vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 ); // quintic fade
			float a = dot( gradient( i ), f );
			float b = dot( gradient( i + vec2( 1.0, 0.0 ) ), f - vec2( 1.0, 0.0 ) );
			float c = dot( gradient( i + vec2( 0.0, 1.0 ) ), f - vec2( 0.0, 1.0 ) );
			float d = dot( gradient( i + vec2( 1.0, 1.0 ) ), f - vec2( 1.0, 1.0 ) );
			return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 1.6; // ~[-1,1]
		}

		// fbm; per-octave drift makes clouds billow instead of scrolling as a rigid stamp
		float fbm( vec2 p, float drift ) {
			float result = 0.0;
			float amplitude = 1.0;
			for ( int i = 0; i < 4; i ++ ) {
				result += amplitude * noise( p );
				amplitude *= 0.5;
				p = p * 2.0 + drift;
			}
			return result;
		}

		// constants for atmospheric scattering
		const float pi = 3.141592653589793238462643383279502884197169;

		const float n = 1.0003; // refractive index of air
		const float N = 2.545E25; // number of molecules per unit volume for air at 288.15K and 1013mb (sea level -45 celsius)

		// optical length at zenith for molecules
		const float rayleighZenithLength = 8.4E3;
		const float mieZenithLength = 1.25E3;
		// 66 arc seconds -> degrees, and the cosine of that
		const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

		// 3.0 / ( 16.0 * pi )
		const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
		// 1.0 / ( 4.0 * pi )
		const float ONE_OVER_FOURPI = 0.07957747154594767;

		float rayleighPhase( float cosTheta ) {
			return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );
		}

		float hgPhase( float cosTheta, float g ) {
			float g2 = pow( g, 2.0 );
			float inverse = 1.0 / pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 );
			return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inverse );
		}

		void main() {

			vec3 direction = normalize( vWorldPosition - cameraPosition );

			// optical length
			// cutoff angle at 90 to avoid singularity in next formula.
			float zenithAngle = acos( max( 0.0, direction.y ) );
			float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
			float sR = rayleighZenithLength * inverse;
			float sM = mieZenithLength * inverse;

			// combined extinction factor
			vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

			// in scattering
			float cosTheta = dot( direction, vSunDirection );

			float rPhase = rayleighPhase( cosTheta * 0.5 + 0.5 );
			vec3 betaRTheta = vBetaR * rPhase;

			float mPhase = hgPhase( cosTheta, mieDirectionalG );
			vec3 betaMTheta = vBetaM * mPhase;

			vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
			Lin *= mix( vec3( 1.0 ), pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * Fex, vec3( 1.0 / 2.0 ) ), clamp( pow( 1.0 - vSunDirection.y, 5.0 ), 0.0, 1.0 ) );

			// nightsky
			float theta = acos( direction.y ); // elevation --> y-axis, [-pi/2, pi/2]
			float phi = atan( direction.z, direction.x ); // azimuth --> x-axis [-pi/2, pi/2]
			vec2 uv = vec2( phi, theta ) / vec2( 2.0 * pi, pi ) + vec2( 0.5, 0.0 );
			vec3 L0 = vec3( 0.1 ) * Fex;

			// composition + solar disc
			float sundisc = clamp( ( cosTheta - sunAngularDiameterCos ) * 50000.0, 0.0, 1.0 ) * showSunDisc;
			vec3 sundiscColor = ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 );

			vec3 texColor = ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );

			// Clouds
			if ( direction.y > 0.0 && cloudCoverage > 0.0 ) {

				// Project to cloud plane (higher elevation = clouds appear lower/closer)
				float elevation = mix( 1.0, 0.1, cloudElevation );
				vec2 cloudUV = direction.xz / ( direction.y * elevation );
				cloudUV *= cloudScale;
				cloudUV += time * cloudSpeed;

				// Cloud density field
				float evolve = time * cloudSpeed * 300.0;
				float cloudNoise = clamp( fbm( cloudUV * 1000.0, evolve ) * 0.7 + 0.5, 0.0, 1.0 );

				// Large-scale coverage variation: clear gaps next to dense banks
				float region = noise( cloudUV * 300.0 ) * 0.37 + 0.5;
				float cov = clamp( cloudCoverage + ( region - 0.5 ) * 0.6, 0.0, 1.0 );

				// Carve clouds where noise rises above the coverage level
				float threshold = 1.0 - cov;
				float cloudMask = smoothstep( threshold, threshold + 0.3, cloudNoise );

				// Fade clouds near horizon (adjusted by elevation)
				float horizonFade = smoothstep( 0.0, 0.03 + 0.06 * cloudElevation, direction.y );
				cloudMask *= horizonFade;

				// Cloud lighting from the sky's own radiance
				float dayFactor = smoothstep( -0.08, 0.3, vSunDirection.y );
				vec3 sunColor = vSunE * Fex * 0.22 * 0.04; // 0.22 ~ albedo/pi, 0.04 = exposure; the aerial composite adds the eye-leg extinction
				vec3 skyAmbient = Lin * 0.04 + vec3( 0.0, 0.0003, 0.00075 );

				// Beer-powder self-shadow from the sampled density
				float depth = max( 0.0, cloudNoise - threshold );
				float beer = exp( depth * -4.0 );
				float powder = 1.0 - beer * beer; // beer*beer == exp(-8*depth)
				float shade = mix( 0.45, 1.0, clamp( beer * powder * 2.6, 0.0, 1.0 ) ); // 2.6 = 1/0.385, normalizes beer*powder peak to 1

				// Henyey-Greenstein forward lobe ( g = 0.7 ): silver lining on rims toward the sun
				float silver = clamp( 0.51 / pow( 1.49 - cosTheta * 1.4, 1.5 ), 0.0, 3.0 ); // 0.51=1-g^2, 1.49=1+g^2, 1.4=2g
				float edge = cloudMask * ( 1.0 - cloudMask ) * 4.0;

				vec3 cloudColor = skyAmbient + sunColor * shade;
				cloudColor += sunColor * silver * edge * 0.6;
				cloudColor *= max( dayFactor, 0.03 );

				// Cloud opacity via Beer's law: density sets how solid the clouds get
				float alpha = ( 1.0 - exp( depth * cloudDensity * -12.0 ) ) * horizonFade;

				// Occlude the sun disc/glow behind opaque cloud
				texColor -= L0 * 0.04 * alpha;

				// Composite through the atmosphere so distant clouds dissolve into haze
				vec3 cloudAerial = mix( texColor, cloudColor, Fex );
				texColor = mix( texColor, cloudAerial, alpha );

			}

			gl_FragColor = vec4( texColor, 1.0 );

			#include <tonemapping_fragment>
			#include <colorspace_fragment>

		}`};var m=class e{resolution;size;cell;half;data;constructor(e,t,n){if(this.resolution=e,this.size=t,this.cell=t/(e-1),this.half=t/2,this.data=n??new Float32Array(e*e),this.data.length!==e*e)throw Error(`Heightfield data has ${this.data.length} samples, expected ${e*e}`)}index(e,t){return t*this.resolution+e}get(e,t){let n=this.resolution-1,r=e<0?0:e>n?n:e,i=t<0?0:t>n?n:t;return this.data[i*this.resolution+r]}set(e,t,n){this.data[t*this.resolution+e]=n}toGrid(e,t){return{gx:(e+this.half)/this.cell,gz:(t+this.half)/this.cell}}colToX(e){return e*this.cell-this.half}rowToZ(e){return e*this.cell-this.half}contains(e,t){return Math.abs(e)<=this.half&&Math.abs(t)<=this.half}sample(e,t){let n=this.resolution-1,r=(e+this.half)/this.cell,i=(t+this.half)/this.cell;r=r<0?0:r>n?n:r,i=i<0?0:i>n?n:i;let a=Math.min(Math.floor(r),n-1),o=Math.min(Math.floor(i),n-1),s=r-a,c=i-o,l=o*this.resolution+a,u=this.data,d=u[l],f=u[l+1],p=u[l+this.resolution],m=u[l+this.resolution+1];return(d*(1-s)+f*s)*(1-c)+(p*(1-s)+m*s)*c}normal(e,n,r=new t){let i=this.cell,a=this.sample(e-i,n),o=this.sample(e+i,n),s=this.sample(e,n-i),c=this.sample(e,n+i);return r.set(a-o,2*i,s-c).normalize()}normalAtSample(e,t,n,r){let i=this.get(e-1,t),a=this.get(e+1,t),o=this.get(e,t-1),s=this.get(e,t+1),c=i-a,l=2*this.cell,u=o-s,d=Math.hypot(c,l,u)||1;n[r]=c/d,n[r+1]=l/d,n[r+2]=u/d}slope(e,t){let n=this.normal(e,t,h);return r.radToDeg(Math.acos(r.clamp(n.y,-1,1)))}rectForCircle(e,t,n,r=0){let{gx:i,gz:a}=this.toGrid(e,t),o=n/this.cell+r,s=this.resolution-1;return{x0:Math.max(0,Math.floor(i-o)),z0:Math.max(0,Math.floor(a-o)),x1:Math.min(s,Math.ceil(i+o)),z1:Math.min(s,Math.ceil(a+o))}}minMax(){let e=1/0,t=-1/0;for(let n=0;n<this.data.length;n++){let r=this.data[n];r<e&&(e=r),r>t&&(t=r)}return{min:e,max:t}}raycast(e,n=2e4,r=new t){let i=Math.max(this.cell*.5,.25),a=g,o=0,s=!0,c=0;if(e.at(0,a),!this.contains(a.x,a.z)){let t=b.set(v.set(-this.half,-1e5,-this.half),y.set(this.half,1e5,this.half)),n=e.intersectBox(t,_);if(!n)return null;c=e.origin.distanceTo(n),o=c}for(;c<n;c+=i*(1+c/400)){if(e.at(c,a),!this.contains(a.x,a.z)){if(c>o+i*4)return null;continue}let t=a.y>this.sample(a.x,a.z);if(!t&&s){let t=o,n=c;for(let r=0;r<24;r++){let r=(t+n)/2;e.at(r,a),a.y>this.sample(a.x,a.z)?t=r:n=r}return e.at(n,r),r.y=this.sample(r.x,r.z),r}s=t,o=c}return null}clone(){return new e(this.resolution,this.size,new Float32Array(this.data))}},h=new t,g=new t,_=new t,v=new t,y=new t,b=new n;export{s as a,c as i,p as n,f as r,m as t};