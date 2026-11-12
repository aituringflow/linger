export const WATER_FRAGMENT_GLSL = `
    precision highp float;
    uniform vec2 resolution;
    uniform vec4 box;
    uniform float pixelRatio,time,amplitude,activity;
    uniform vec2 caret;
    uniform float caretVisible;
    uniform vec3 tint;
    uniform sampler2D waterTexture;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
    float fbm(vec2 p){return .5*noise(p)+.25*noise(p*2.13+7.)+.15*noise(p*4.27-4.)+.07*noise(p*8.21+11.)+.03*noise(p*16.4);}
    float sdRoundBox(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
    void main(){
      vec2 p=vec2(gl_FragCoord.x/pixelRatio,resolution.y-gl_FragCoord.y/pixelRatio);
      vec2 center=box.xy+box.zw*.5;
      float radius=box.w<250.?22.:28.;
      float halfW=box.z*.5;
      float d=sdRoundBox(p-center,box.zw*.5,radius);
      float top=box.y,bottom=box.y+box.w;
      float topZone=1.-smoothstep(top+6.,top+42.,p.y);
      float topWeight=.54+.27*fbm(vec2(p.x*.008-time*.10,2.4));
      // Keep the film width continuous around the whole rounded contour.
      float reach=6.+amplitude*7.+topWeight*2.;
      // A wind-driven field crosses the whole frame diagonally; no center source.
      float swell=fbm(vec2(p.x*.019-time*.19,p.y*.012-time*.08));
      float breakup=fbm(vec2(p.x*.061-time*.32,p.y*.052-time*.27));
      float detail=fbm(vec2(p.x*.14-time*.62,p.y*.12-time*.48));
      float crest=pow(smoothstep(.45,.71,fbm(vec2(p.x*.031-time*.23,p.y*.015))),1.3)*3.5*amplitude*topZone;
      float boundary=reach*(.44+swell*.84)+(breakup-.5)*5.*amplitude+crest;
      // Displace the existing water boundary smoothly at the caret's horizontal position.
      float pressX=clamp(caret.x,box.x+radius,box.x+box.z-radius);
      float press=exp(-pow((p.x-pressX)/28.,2.))*topZone*activity*caretVisible;
      boundary+=press*16.;
      float outside=smoothstep(-.5,1.5,d);
      float body=outside*(1.-smoothstep(boundary-5.,boundary+4.,d));
      float leftSupply=.54+.27*fbm(vec2((box.x+radius)*.008-time*.10,2.4));
      float rightSupply=.54+.27*fbm(vec2((box.x+box.z-radius)*.008-time*.10,2.4));
      float cornerSupply=p.x<center.x?leftSupply:rightSupply;
      float sideTransfer=smoothstep(top+radius-9.,top+radius+18.,p.y);
      float supply=mix(topWeight,cornerSupply,sideTransfer);
      float sideDrain=smoothstep(top+radius-9.,bottom-25.,p.y);
      float attenuation=(1.-sideDrain*.12)*supply;
      // The bottom is an exterior film following the same rounded contour.
      float water=body*(.27+.60*breakup+.23*detail)*attenuation;
      float brokenEdge=exp(-abs(d-boundary+1.)/3.3);
      float froth=pow(smoothstep(.47,.72,detail),1.6)*body*.52;
      froth+=brokenEdge*(.22+.55*breakup);
      float lace=pow(smoothstep(.57,.8,fbm(vec2(p.x*.19-time*.85,p.y*.18-time*.28))),2.)*body*.32;
      froth+=lace;
      froth*=attenuation;
      // Water leaves the two upper corners as a falling sheet, then breaks
      // into smaller streams and droplets instead of abruptly ending.
      float fallY=p.y-(top+radius*.42);
      float fallGate=smoothstep(-13.,9.,fallY)*(1.-smoothstep(bottom-22.,bottom+1.,p.y));
      float driftL=(fbm(vec2(fallY*.019-time*.65,2.7))-.5)*12.;
      float driftR=(fbm(vec2(fallY*.019-time*.65,8.3))-.5)*12.;
      float fallWidth=mix(8.,4.,smoothstep(0.,box.w,fallY))*amplitude;
      float cornerT=clamp((p.y-(bottom-radius))/radius,0.,1.);
      float arcShift=radius*(1.-sqrt(max(0.,1.-cornerT*cornerT)));
      float leftX=box.x-9.+driftL+arcShift;
      float rightX=box.x+box.z+9.+driftR-arcShift;
      float leftSheet=exp(-pow(abs(p.x-leftX)/max(2.,fallWidth),1.7));
      float rightSheet=exp(-pow(abs(p.x-rightX)/max(2.,fallWidth),1.7));
      float falling=(leftSheet*leftSupply+rightSheet*rightSupply)*fallGate*(.07+.17*breakup)*outside;
      float fallFoam=falling*pow(smoothstep(.47,.73,detail),1.4);
      float spray=0.;
      for(int i=0;i<22;i++){
        float fi=float(i),seed=hash(vec2(fi,3.));
        float travel=mod(time*(38.+seed*28.)+hash(vec2(fi,8.))*(box.w+110.),box.w+110.);
        float branch=mod(fi,2.)<1.?-1.:1.;
        float qY=top+radius*.42+travel;
        float dx=9.+travel*.035+(hash(vec2(fi,11.))-.5)*25.;
        float qT=clamp((qY-(bottom-radius))/radius,0.,1.);
        float qArc=radius*(1.-sqrt(max(0.,1.-qT*qT)));
        vec2 q=vec2(center.x+branch*(halfW+dx-qArc),qY);
        float size=.6+hash(vec2(fi,15.))*1.9;
        float fade=1.-smoothstep(bottom-30.,bottom-5.,qY);
        spray+=exp(-dot(p-q,p-q)/(size*size))*fade*(.3+seed*.5)*(branch<0.?leftSupply:rightSupply);
      }
      vec2 uv=vec2(fract((p.x-box.x)/box.z*.84+p.y*.00035-time*.018+(breakup-.5)*.012),
                   1.-(.06+clamp((d+6.)/80.,0.,1.)*.35));
      vec3 photo=texture2D(waterTexture,uv).rgb;
      float brightness=dot(photo,vec3(.2126,.7152,.0722));
      vec3 white=vec3(.93,.98,.99);
      vec3 color=mix(tint*.34,tint*1.08,smoothstep(.12,.74,brightness));
      color=mix(color,mix(tint,white,.28),smoothstep(.62,.94,brightness)*.55);
      color=mix(color,white,clamp(froth*.72+fallFoam*.44+spray*.65,0.,.88));
      float cornerArc=exp(-abs(d-2.)/3.5)*outside
                      *smoothstep(bottom-radius-18.,bottom-radius+2.,p.y)
                      *(1.-smoothstep(bottom+1.,bottom+8.,p.y))
                      *smoothstep(halfW-radius-28.,halfW-radius+3.,abs(p.x-center.x))
                      *cornerSupply;
      // A continuous exterior meniscus carries the side flow around the
      // lower corners; no water is drawn over the input surface.
      float bottomMeniscus=exp(-abs(d-2.)/3.2)*outside
                           *smoothstep(bottom-radius-13.,bottom-radius+1.,p.y)
                           *(1.-smoothstep(bottom+2.,bottom+7.,p.y))
                           *mix(.48,.68,swell);
      float alpha=clamp(water*.78+froth*.43+falling*.56+spray*.43+cornerArc*.27+bottomMeniscus*.25,0.,.88)*outside;
      alpha*=1.+activity*.07;
      alpha*=smoothstep(0.,.2,amplitude);
      gl_FragColor=vec4(color,clamp(alpha,0.,.96));
    }`;
