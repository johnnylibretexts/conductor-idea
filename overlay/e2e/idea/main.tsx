import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, Route, Switch} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import axios from 'axios';
import ProjectIdeaReview from '../../client/src/components/projects/idea/ProjectIdeaReview';
import SynthesisView from '../../client/src/components/projects/idea/SynthesisView';
// Match Platform.tsx: every client API shares this prefix.
axios.defaults.baseURL='/api/v1';
const params=new URLSearchParams(location.search);
fetch('/__idea-test/session?role='+encodeURIComponent(params.get('role')||'owner')).then(r=>r.json()).then(session=>{
 axios.defaults.headers.common.Authorization=session.token;
 createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><BrowserRouter><Switch><Route path="/projects/:id/idea-syntheses/:synthesisID?" component={SynthesisView}/><Route path="/projects/:id/idea/:reviewID?" component={ProjectIdeaReview}/></Switch></BrowserRouter></QueryClientProvider>);
});
