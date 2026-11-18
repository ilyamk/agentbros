import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { TimelineComposition } from '../../src/components/TimelineComposition';
import type { ProjectVideoProps } from '../../src/lib/project-props';
import type { TimelineIR } from '../../src/types/timeline';
const props: ProjectVideoProps & {timeline:TimelineIR}={projectId:'test',format:'landscape',productName:'Offline fixture',tagline:'',accentColor:'#FFE600',bgColor:'#000000',textColor:'#FFFFFF',scenes:[],voiceoverEnabled:true,musicVolume:0,timeline:{version:1,projectId:'test',timebase:{num:30,den:1},tracks:[]}};
registerRoot(()=> <Composition id="VisualFrameAcceptance" component={TimelineComposition} width={1920} height={1080} fps={30} durationInFrames={90} defaultProps={props}/>);
