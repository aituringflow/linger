export const GOLD_FRAGMENT_GLSL = `
    precision highp float;
    uniform vec2 resolution;
    uniform vec4 box;
    uniform float pixelRatio,time,sparkle,activity;
    uniform float idleAngle,idleActivity;
    uniform float trailLength,trailStrength;
    uniform vec4 particles[32];
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
    float fbm(vec2 p){return .55*noise(p)+.28*noise(p*2.07+8.)+.12*noise(p*4.13-4.)+.05*noise(p*8.1);}
    float sdBox(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
    vec2 borderPoint(float distance,vec4 b,float r){
      vec2 h=b.zw*.5,c=h-r;
      float arc=1.57079633*r;
      float length=4.*(c.x+c.y)+4.*arc;
      float s=mod(distance+c.x+length,length);
      vec2 q;
      if(s<2.*c.x){q=vec2(-c.x+s,-h.y);}
      else if((s-=2.*c.x)<arc){float a=s/r;q=vec2(c.x+r*sin(a),-c.y-r*cos(a));}
      else if((s-=arc)<2.*c.y){q=vec2(h.x,-c.y+s);}
      else if((s-=2.*c.y)<arc){float a=s/r;q=vec2(c.x+r*cos(a),c.y+r*sin(a));}
      else if((s-=arc)<2.*c.x){q=vec2(c.x-s,h.y);}
      else if((s-=2.*c.x)<arc){float a=s/r;q=vec2(-c.x-r*sin(a),c.y+r*cos(a));}
      else if((s-=arc)<2.*c.y){q=vec2(-h.x,c.y-s);}
      else{float a=(s-2.*c.y)/r;q=vec2(-c.x-r*cos(a),-c.y-r*sin(a));}
      return b.xy+h+q;
    }
    void main(){
      vec2 p=vec2(gl_FragCoord.x/pixelRatio,resolution.y-gl_FragCoord.y/pixelRatio);
      vec2 center=box.xy+box.zw*.5;
      float d=sdBox(p-center,box.zw*.5,box.w<215.?18.:23.);
      float radius=box.w<215.?18.:23.;
      vec2 local=p-center;
      vec2 q=abs(local), straight=box.zw*.5-radius;
      float quarter;
      if(q.x<=straight.x){quarter=q.x;}
      else if(q.y<=straight.y){quarter=straight.x+1.57079633*radius+straight.y-q.y;}
      else{quarter=straight.x+radius*atan(q.x-straight.x,q.y-straight.y);}
      float halfLength=2.*(straight.x+straight.y)+3.14159265*radius;
      float perimeter=2.*halfLength;
      float distanceAlong=local.y<0.?(local.x>=0.?quarter:perimeter-quarter)
        :(local.x>=0.?halfLength-quarter:halfLength+quarter);
      float a=distanceAlong/perimeter*6.28318531;
      float ore=fbm(p*.078);
      float rim=exp(-abs(d-1.5)/2.2);
      float outer=exp(-abs(d-6.)/5.5)*.33;
      float sweep=pow(max(0.,cos(a-time*1.45)),18.);
      float sweep2=pow(max(0.,cos(a-time*1.45-2.1)),34.)*.38;
      float phase=mod(distanceAlong-idleAngle+perimeter*.5,perimeter)-perimeter*.5;
      float idleSweep=exp(-phase*phase/(2.*42.*42.))*idleActivity;
      float gleam=((sweep+sweep2)*clamp(activity,0.,1.)+idleSweep)*exp(-abs(d-1.)/8.);
      float band=clamp(rim*.79+outer*.48+gleam*.72,0.,1.);
      float mote=0.;
      // Solid flecks are born on the border, then drift upward at individual speeds.
      float dust=0.;
      for(int i=0;i<32;i++){
        vec4 particle=particles[i];
        float spawn=particle.x;
        float age=particle.y;
        vec2 origin=borderPoint(spawn,box,radius);
        vec2 velocity=vec2(particle.z,-particle.w);
        vec2 position=origin+velocity*age;
        float size=mix(.72,.9,hash(vec2(spawn,49.)));
        float fleck=1.-smoothstep(size*.55,size+.35,length(p-position));
        float ageFade=smoothstep(0.,.08,age)*(1.-smoothstep(1.1,1.8,age));
        dust+=fleck*ageFade*step(0.,age);
      }
      mote+=dust*sparkle*.38;
      float glitter=pow(smoothstep(.56,.81,ore),3.)*rim*sparkle*.56;
      vec3 bronze=vec3(.31,.16,.05),gold=vec3(.86,.56,.19),bright=vec3(1.,.89,.52),white=vec3(1.,.99,.83);
      vec3 color=mix(bronze,gold,ore*.8+.13);
      color=mix(color,bright,clamp(rim*.34+glitter+gleam*.67,0.,1.));
      color=mix(color,white,clamp(gleam*.48+mote*.25,0.,.91));
      float alpha=clamp(band*(.68+.3*ore)+mote*.76+glitter*.32,0.,.95);
      gl_FragColor=vec4(color,clamp(alpha,0.,1.));
    }`;
